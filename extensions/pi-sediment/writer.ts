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

function extractWriteJson(text: string): WriterOutput | null {
  let body = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1];
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  if (open === -1 || close === -1 || close <= open) return null;
  let parsed: any;
  try { parsed = JSON.parse(body.slice(open, close + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;

  const pensieve = parsePensieveEntry(parsed.pensieve);
  const gbrain = parseGbrainEntry(parsed.gbrain);

  if (!pensieve && !gbrain) return null;
  return { pensieve, gbrain };
}

function parsePensieveEntry(raw: any): WriterOutput["pensieve"] {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind;
  if (kind !== "knowledge" && kind !== "decision" && kind !== "maxim") return null;
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  if (!slug) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : slug;
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (content.length < 50) return null;
  return { kind, slug, label, content };
}

function parseGbrainEntry(raw: any): WriterOutput["gbrain"] {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (content.length < 50) return null;
  let tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    tags = raw.tags.filter((t: any) => typeof t === "string").map((t: string) => t.trim().toLowerCase());
  }
  if (!tags.includes("engineering")) tags.unshift("engineering");
  return { title, tags, content };
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
        maxTokens: 4096,
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

    const result = extractWriteJson(text);
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
