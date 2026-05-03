/**
 * pi-sediment gbrain writer — single model call produces a gbrain page.
 *
 * Supports format error feedback: when `input.formatError` is set, the prompt
 * includes the error to help the LLM fix its output format on retry.
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

function extractGbrainOutput(text: string, projectRoot: string): { output: GbrainWriteOutput; parseError?: string } | null {
  let clean = text.trim();

  // ── Step 1: strip code fences ──
  clean = clean
    .replace(/^```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  // ── Step 2: find the GBRAIN section header ──
  const headerRegex = /^#{2,3}\s+GBRAIN\s*$/mi;
  const match = clean.match(headerRegex);
  const hasGbrianHeader = match && match.index !== undefined;

  let raw: string;
  if (hasGbrianHeader) {
    const bodyStart = match.index + match[0].length;
    // Keep the full section after ## GBRAIN. The body legitimately contains
    // nested ## headings (Principle, Guidance, Timeline); stopping at the next
    // ## would silently truncate content and drop timeline/link material.
    raw = clean.slice(bodyStart).trim();
  } else {
    logLine(projectRoot, `gbrain-writer parse:warn no ## GBRAIN header, trying fallback`);
    raw = clean;
  }
  if (!raw) return null;

  // ── Step 3: split on __CONTENT__ ──
  let header: string;
  let content: string;
  const contentIdx = raw.search(/__CONTENT__/i);
  if (contentIdx !== -1) {
    header = raw.slice(0, contentIdx).trim();
    content = raw.slice(contentIdx + "__CONTENT__".length).trim();
  } else {
    const headingMatch = raw.match(/^#\s+.+$/m);
    if (!headingMatch || headingMatch.index === undefined) {
      saveParseFailure(text, projectRoot, "no-content-separator");
      return null;
    }
    header = raw.slice(0, headingMatch.index).trim();
    content = raw.slice(headingMatch.index).trim();
    logLine(projectRoot, `gbrain-writer parse:warn no __CONTENT__, split on # heading`);
  }
  if (!content || content.length < 60) {
    saveParseFailure(text, projectRoot, "content-too-short");
    return null;
  }

  // ── Step 4: extract title ──
  let title = extractField(header, "title");
  if (!title) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
      logLine(projectRoot, `gbrain-writer parse:warn title from # heading`);
    }
  }
  if (!title) {
    saveParseFailure(text, projectRoot, "no-title");
    // Return parse error for retry feedback
    return null;
  }

  // ── Step 5: extract tags ──
  const tagsRaw = extractField(header, "tags");
  let tags = tagsRaw
    ? tagsRaw.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  if (!tags.includes("engineering")) tags.unshift("engineering");

  // ── Step 6: sanitize ──
  if (!sanitizeContent(content)) {
    saveParseFailure(raw, projectRoot, "injection");
    return null;
  }

  return { output: { title, tags, content } };
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

export interface WriteResult {
  output: GbrainWriteOutput;
  /** Raw text output from the LLM (for format error feedback on retry). */
  rawText: string;
}

export async function writeForGbrain(
  input: GbrainWriteInput,
  projectRoot: string,
  registry: ModelRegistry,
): Promise<WriteResult | null> {
  const config = loadConfig(projectRoot);
  const tag = `gbrain-writer`;
  const isRetry = !!input.formatError;

  const resolved = await resolveModel(registry, projectRoot);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.writeTimeoutMs);

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

    const extracted = extractGbrainOutput(text, projectRoot);
    if (!extracted) {
      logLine(projectRoot, `${tag} parse:fail rawlen=${text.length} attempt=${isRetry ? "retry" : "first"}`);
      // Return raw text so caller can construct format error for retry
      return { output: null as any, rawText: text };
    }

    const related = input.relatedPages
      .map((p) => p.title.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim())
      .filter((title) => Boolean(title) && title !== extracted.output.title)
      .slice(0, 5);
    const output = related.length > 0
      ? { ...extracted.output, related }
      : extracted.output;

    logLine(projectRoot, `${tag} done: title="${output.title.slice(0, 80)}"${isRetry ? " (retry)" : ""}`);
    return { output, rawText: text };
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Check if a WriteResult indicates a parse failure that can be retried. */
export function isParseFailure(result: WriteResult): boolean {
  return !result.output;
}

/** Build format error feedback string from the raw LLM output. */
export function buildFormatError(rawText: string): string {
  const errors: string[] = [];

  if (!/^#{2,3}\s+GBRAIN/mi.test(rawText)) {
    errors.push("Missing '## GBRAIN' section header — output must start with this exact header.");
  }
  if (!/__CONTENT__/i.test(rawText)) {
    errors.push("Missing '__CONTENT__' separator — the header and body must be separated by '__CONTENT__' on its own line.");
  }
  if (!/^title:\s*.+/mi.test(rawText)) {
    errors.push("Missing 'title:' field — the header must include a 'title: Your Title Here' line.");
  }
  if (!/^tags:\s*.+/mi.test(rawText)) {
    errors.push("Missing 'tags:' field — must include at least 'tags: engineering, topic'.");
  }

  if (errors.length === 0) {
    // Generic: output exists but couldn't be parsed
    return "Output format incorrect. Ensure the exact format:\n## GBRAIN\ntitle: ...\ntags: ...\n__CONTENT__\n# Title\n\nBody...";
  }

  return "FORMAT ERRORS DETECTED:\n" + errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n") +
    "\n\nPlease re-output following the exact format shown in the system prompt.";
}
