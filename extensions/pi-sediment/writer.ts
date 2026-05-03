/**
 * pi-sediment gbrain writer — single model call produces a gbrain page.
 *
 * Pensieve writing is delegated to /skill:pensieve self-improve.
 * This module handles gbrain only: generates markdown with [[wikilink]]
 * cross-references and timeline entries.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRef, loadConfig } from "./config.js";
import { GBRAIN_WRITE_PROMPT, buildGbrainWritePrompt, sanitizeContent } from "./prompts.js";
import type { GbrainWriteInput, GbrainWriteOutput, ResolvedModel } from "./types.js";

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

function extractGbrainOutput(text: string, projectRoot: string): GbrainWriteOutput | null {
  let clean = text.trim();
  // Strip outer code fences if present
  let fenceMatch = clean.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (!fenceMatch) {
    fenceMatch = clean.match(/^```\s*\n([\s\S]*?)\n```\s*$/);
  }
  if (fenceMatch) clean = fenceMatch[1];

  // Extract GBRAIN section
  const headerRegex = /^#{2,3}\s+GBRAIN\s*$/mi;
  const match = clean.match(headerRegex);
  if (!match || match.index === undefined) return null;

  const bodyStart = match.index + match[0].length;
  const nextHeader = clean.slice(bodyStart).match(/^#{2,3}\s+/m);
  const bodyEnd = nextHeader && nextHeader.index !== undefined
    ? bodyStart + nextHeader.index
    : clean.length;
  const raw = clean.slice(bodyStart, bodyEnd).trim();
  if (!raw) return null;

  // Split on __CONTENT__
  const contentIdx = raw.search(/__CONTENT__/i);
  if (contentIdx === -1) return null;

  const header = raw.slice(0, contentIdx).trim();
  const content = raw.slice(contentIdx + "__CONTENT__".length).trim();
  if (!content || content.length < 100) return null;

  const title = extractField(header, "title");
  if (!title) return null;

  const tagsRaw = extractField(header, "tags");
  let tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
  if (!tags.includes("engineering")) tags.unshift("engineering");

  // Sanitize against injection
  if (!sanitizeContent(content)) {
    saveParseFailure(raw, projectRoot, "injection");
    return null;
  }

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

function saveParseFailure(raw: string, projectRoot: string, reason: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment", "parse-failures");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${ts}-${reason}.md`);
    fs.writeFileSync(file, raw, "utf8");
    logLine(projectRoot, `gbrain-writer parse:fail reason=${reason} saved=${file}`);
  } catch { /* silent */ }
}

// ── Public ─────────────────────────────────────────────────────

export async function writeForGbrain(
  input: GbrainWriteInput,
  projectRoot: string,
  registry: ModelRegistry,
  signal: AbortSignal | undefined,
): Promise<GbrainWriteOutput | null> {
  const config = loadConfig(projectRoot);
  const tag = `gbrain-writer`;

  const resolved = await resolveModel(registry, projectRoot);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.writeTimeoutMs);
  const onParent = () => ac.abort(new Error("parent aborted"));
  signal?.addEventListener("abort", onParent, { once: true });

  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: GBRAIN_WRITE_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildGbrainWritePrompt(input) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        signal: ac.signal,
        maxTokens: 32768,
        ...(config.reasoning !== "off" ? { reasoning: config.reasoning } : {}),
      },
    );

    if (response.stopReason === "error") {
      logLine(projectRoot, `${tag} call:error ${response.errorMessage || "unknown"}`);
      return null;
    }
    if (response.stopReason === "aborted") {
      logLine(projectRoot, `${tag} call:aborted`);
      return null;
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const result = extractGbrainOutput(text, projectRoot);
    if (!result) {
      logLine(projectRoot, `${tag} parse:fail rawlen=${text.length}`);
      return null;
    }

    logLine(projectRoot, `${tag} done: title="${result.title.slice(0, 80)}"`);
    return result;
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParent);
  }
}
