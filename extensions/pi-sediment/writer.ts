/**
 * pi-sediment writer — single model call produces Pensieve + gbrain dual output.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRef, loadConfig } from "./config.js";
import { WRITE_SYSTEM_PROMPT, buildWritePrompt } from "./prompts.js";
import type { ResolvedModel, WriterOutput } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────

async function resolveModel(
  registry: ModelRegistry,
  projectRoot: string,
): Promise<ResolvedModel | { error: string }> {
  const config = loadConfig(projectRoot);
  const m = registry.find(config.model.provider, config.model.modelId);
  if (!m) return { error: `model not found: ${formatModelRef(config.model)}` };
  const auth = await registry.getApiKeyAndHeaders(m);
  if (!auth.ok) return { error: `auth failed: ${auth.error}` };
  if (!auth.apiKey) return { error: "no api key" };
  return { model: m, apiKey: auth.apiKey, headers: auth.headers, display: formatModelRef(config.model) };
}

function extractWriteOutput(text: string): WriterOutput | null {
  // Strip outer code fences if present (model sometimes wraps output)
  let clean = text.trim();
  const fenceMatch = clean.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) clean = fenceMatch[1];

  const pensieveRaw = extractSection(clean, "PENSIEVE");
  const gbrainRaw = extractSection(clean, "GBRAIN");

  const pensieve = pensieveRaw ? parsePensieveSection(pensieveRaw) : null;
  const gbrain = gbrainRaw ? parseGbrainSection(gbrainRaw) : null;

  if (!pensieve && !gbrain) return null;
  return { pensieve, gbrain };
}

function extractSection(text: string, name: string): string | null {
  // Match markdown header: ## NAME or ## NAME (with trailing text)
  const headerRegex = new RegExp(`^##\\s+${name}\\s*$`, "mi");
  const match = text.match(headerRegex);
  if (!match || match.index === undefined) return null;

  const bodyStart = match.index + match[0].length;
  // Find the next ## header as boundary
  const nextHeader = text.slice(bodyStart).match(/^##\s+/m);
  const bodyEnd = nextHeader && nextHeader.index !== undefined
    ? bodyStart + nextHeader.index
    : text.length;

  const body = text.slice(bodyStart, bodyEnd).trim();
  if (!body || body === "NULL") return null;
  return body;
}

function parsePensieveSection(raw: string): WriterOutput["pensieve"] {
  const parts = raw.split("__CONTENT__");
  const header = parts[0]?.trim() ?? "";
  const content = parts.slice(1).join("__CONTENT__").trim();

  if (!content || content.length < 300) return null;
  // Validate Pensieve frontmatter
  if (!content.startsWith("---")) return null;
  if (!/^type:\s*(knowledge|decision|maxim)/m.test(content)) return null;

  const kind = extractField(header, "kind") as "knowledge" | "decision" | "maxim" | null;
  if (!kind || !["knowledge", "decision", "maxim"].includes(kind)) return null;

  const slug = extractField(header, "slug");
  if (!slug) return null;

  const label = extractField(header, "label") || slug;

  return { kind, slug, label, content };
}

function parseGbrainSection(raw: string): WriterOutput["gbrain"] {
  const parts = raw.split("__CONTENT__");
  const header = parts[0]?.trim() ?? "";
  const content = parts.slice(1).join("__CONTENT__").trim();

  if (!content || content.length < 300) return null;

  const title = extractField(header, "title");
  if (!title) return null;

  const tagsRaw = extractField(header, "tags");
  let tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
  if (!tags.includes("engineering")) tags.unshift("engineering");

  return { title, tags, content };
}

function extractField(header: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = header.match(regex);
  return match?.[1]?.trim() ?? null;
}

function logLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* silent */ }
}

// ── Public ─────────────────────────────────────────────────────

export async function write(
  summary: string,
  lastAssistantMessage: string,
  projectRoot: string,
  registry: ModelRegistry,
  signal: AbortSignal | undefined,
): Promise<WriterOutput> {
  const config = loadConfig(projectRoot);
  const tag = `writer`;

  const resolved = await resolveModel(registry, projectRoot);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return { pensieve: null, gbrain: null };
  }

  const dateIso = new Date().toISOString().slice(0, 10);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.writeTimeoutMs);
  const onParent = () => ac.abort(new Error("parent aborted"));
  signal?.addEventListener("abort", onParent, { once: true });

  try {
    const response = await complete(
      resolved.model,
      {
        systemPrompt: WRITE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildWritePrompt({ summary, lastAssistantMessage, dateIso }) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        signal: ac.signal,
        maxTokens: 32768,
      },
    );

    if (response.stopReason === "error") {
      logLine(projectRoot, `${tag} call:error ${response.errorMessage || "unknown"}`);
      return { pensieve: null, gbrain: null };
    }
    if (response.stopReason === "aborted") {
      logLine(projectRoot, `${tag} call:aborted`);
      return { pensieve: null, gbrain: null };
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const result = extractWriteOutput(text);
    if (!result) {
      logLine(projectRoot, `${tag} parse:fail rawlen=${text.length}`);
      return { pensieve: null, gbrain: null };
    }

    const parts: string[] = [];
    if (result.pensieve) parts.push(`pensieve:${result.pensieve.kind}/${result.pensieve.slug}`);
    if (result.gbrain) parts.push(`gbrain:${result.gbrain.title}`);
    logLine(projectRoot, `${tag} done: ${parts.join(" + ")}`);
    return result;
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return { pensieve: null, gbrain: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParent);
  }
}
