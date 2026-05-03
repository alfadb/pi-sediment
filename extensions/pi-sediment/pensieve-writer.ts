/**
 * pi-sediment Pensieve writer — single LLM call (evaluate + write combined).
 *
 * One prompt handles both decisions: return SKIP or produce a full Pensieve entry.
 * Writes to .pensieve/short-term/ then refreshes project state.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { formatModelRef, loadConfig } from "./config.js";
import { sanitizeContent } from "./prompts.js";
import { sanitizeSlug } from "./utils.js";
import type { ResolvedModel } from "./types.js";

// ── Prompt ─────────────────────────────────────────────────────

const PENSIEVE_PROMPT = `You are the pi-sediment Pensieve writer.

Read the assistant message below and decide whether it contains a project-specific
insight worth saving to Pensieve. Pensieve stores file paths, module boundaries,
call chains, architectural decisions, and project conventions.

If the message is NOT worth saving (routine execution, status update, user question,
already-known fact), output exactly:

SKIP

If it IS worth saving, output a Pensieve entry:

## PENSIEVE
kind: knowledge | decision | maxim
slug: lowercase-hyphenated-slug
label: <= 60 char headline
__CONTENT__
---
type: {kind}
title: {one-line title}
id: {slug}
status: active
created: {date}
updated: {date}
tags: [tag1, tag2]
---

# Title

Body content with file paths and module names (>= 100 words).

RULES:
- kind: "maxim" for hard rules, "decision" for architectural tradeoffs, "knowledge" for facts
- slug lowercase hyphenated, no special chars
- label <= 60 chars, human-readable
- Include file paths and module names in body
- Output SKIP (nothing else) if the message has no durable insight
- Output the full entry if it does`;

// ── Locate skill root ──────────────────────────────────────────

function getSkillRoot(): string | null {
  const candidates = [
    process.env.PENSIEVE_SKILL_ROOT,
    path.join(os.homedir(), ".pi", "agent", "skills", "pensieve"),
    path.join(os.homedir(), ".claude", "skills", "pensieve"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".src", "manifest.json"))) return c;
  }
  return null;
}

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

function extractField(text: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = text.match(regex);
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

export type PensieveWriteStatus = "written" | "skipped" | "failed";

export async function writePensieve(
  message: string,
  projectRoot: string,
  registry: ModelRegistry,
): Promise<PensieveWriteStatus> {
  const config = loadConfig(projectRoot);
  const tag = "pensieve-writer";
  const dateIso = new Date().toISOString().slice(0, 10);

  const resolved = await resolveModel(registry, projectRoot);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return "failed";
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.writeTimeoutMs);

  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: PENSIEVE_PROMPT,
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: `Date: ${dateIso}\n\nAssistant message:\n\n<message>\n${message}\n</message>`,
          }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        signal: ac.signal,
        maxTokens: 16384,
        ...(config.reasoning !== "off" ? { reasoning: config.reasoning } : {}),
      },
    );

    if (response.stopReason === "error") {
      logLine(projectRoot, `${tag} call:error ${response.errorMessage || "unknown"}`);
      return "failed";
    }
    if (response.stopReason === "aborted") {
      logLine(projectRoot, `${tag} call:aborted`);
      return "failed";
    }
    if (response.stopReason === "length") {
      logLine(projectRoot, `${tag} call:length`);
      return "failed";
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // Check for SKIP
    if (/^SKIP\s*$/im.test(text)) {
      logLine(projectRoot, `${tag} decision:skip`);
      return "skipped";
    }

    // Parse PENSIEVE section
    let clean = text
      .replace(/^```(?:markdown|md)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    const headerRegex = /^#{2,3}\s+PENSIEVE\s*$/mi;
    const headerMatch = clean.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      logLine(projectRoot, `${tag} parse:fail no ## PENSIEVE header`);
      return "failed";
    }

    const bodyStart = headerMatch.index + headerMatch[0].length;
    // Keep the full section after ## PENSIEVE. The body may contain nested
    // ## headings; stopping at the next ## would silently truncate content.
    const raw = clean.slice(bodyStart).trim();
    if (!raw) return "failed";

    const contentIdx = raw.search(/__CONTENT__/i);
    if (contentIdx === -1) {
      logLine(projectRoot, `${tag} parse:fail no __CONTENT__`);
      return "failed";
    }

    const header = raw.slice(0, contentIdx).trim();
    let content = raw.slice(contentIdx + "__CONTENT__".length).trim();
    if (!content || content.length < 100) {
      logLine(projectRoot, `${tag} parse:fail content too short`);
      return "failed";
    }

    content = content.replace(/^\n+/, "");
    if (!content.startsWith("---")) return "failed";
    if (!/^type:\s*(knowledge|decision|maxim)/m.test(content)) return "failed";

    const kind = extractField(header, "kind");
    if (!kind || !["knowledge", "decision", "maxim"].includes(kind)) return "failed";

    const slug = sanitizeSlug(extractField(header, "slug") || kind);
    const label = extractField(header, "label") || slug;

    // Sanitize
    if (!sanitizeContent(content)) {
      logLine(projectRoot, `${tag} parse:fail injection`);
      return "failed";
    }

    // ── Write to Pensieve ──────────────────────────────────
    const pensieveDir = path.join(projectRoot, ".pensieve");
    if (!fs.existsSync(pensieveDir)) return "failed";

    let target: string;
    if (kind === "knowledge") {
      const dir = path.join(pensieveDir, "short-term", "knowledge", slug);
      fs.mkdirSync(dir, { recursive: true });
      target = path.join(dir, "content.md");
    } else if (kind === "decision") {
      const dir = path.join(pensieveDir, "short-term", "decisions");
      fs.mkdirSync(dir, { recursive: true });
      target = path.join(dir, `${dateIso}-${slug}.md`);
    } else {
      const dir = path.join(pensieveDir, "short-term", "maxims");
      fs.mkdirSync(dir, { recursive: true });
      target = path.join(dir, `${slug}.md`);
    }

    // Avoid overwrite
    let final = target;
    let i = 2;
    while (fs.existsSync(final)) {
      const ext = path.extname(target);
      const base = target.slice(0, -ext.length);
      final = `${base}-${i}${ext}`;
      i++;
      if (i > 50) break;
    }
    fs.writeFileSync(final, content, "utf8");

    // Refresh project state
    const skillRoot = getSkillRoot();
    if (skillRoot) {
      const script = path.join(skillRoot, ".src", "scripts", "maintain-project-state.sh");
      if (fs.existsSync(script)) {
        const proc = spawn("bash", [script, "--event", "self-improve", "--note", `pi-sediment: ${label}`], {
          cwd: projectRoot,
          env: { ...process.env, PENSIEVE_SKILL_ROOT: skillRoot, PENSIEVE_PROJECT_ROOT: projectRoot, PENSIEVE_HARNESS: "pi" },
          stdio: "ignore",
          detached: true,
        });
        proc.on("error", () => {});
        proc.unref();
      }
    }

    logLine(projectRoot, `${tag} done: ${kind}/${slug}`);
    return "written";
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
