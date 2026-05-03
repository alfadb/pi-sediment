/**
 * pi-sediment Pensieve writer — single model call produces a Pensieve entry.
 *
 * Generates Pensieve-formatted markdown with project-specific details:
 * file paths, module names, architectural context.
 *
 * TODO: When extension-to-skill invocation is available in pi, this will be
 * replaced by /skill:pensieve self-improve delegation.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRef, loadConfig } from "./config.js";
import type { PensieveEntry, ResolvedModel } from "./types.js";

// ── Pensieve writer prompt ──────────────────────────────────────

const PENSIEVE_WRITE_PROMPT = `You are the pi-sediment Pensieve writer.

Given a project-specific engineering insight, produce a Pensieve entry using markdown.

Output format:

## PENSIEVE
kind: knowledge | decision | maxim
slug: lowercase-hyphenated-slug
label: <= 60 char headline
__CONTENT__
---
type: {kind}
title: {one-line title matching the # Title heading below}
id: {slug}
status: active
created: {date}
updated: {date}
tags: [tag1, tag2]
---

# Title

Body content with file paths, module names, project-specific details.

RULES:
- kind: "maxim" for hard rules, "decision" for architectural tradeoffs, "knowledge" for facts/explorations
- The frontmatter MUST include both 'title' (matching the # heading) and 'updated' (same as created) fields
- Content MUST include file paths and module names where relevant
- slug must be lowercase hyphenated
- Body must be >= 100 words`;

function buildPensieveWritePrompt(args: {
  summary: string;
  lastAssistantMessage: string;
  dateIso: string;
}): string {
  return `Insight summary: ${args.summary}

Date: ${args.dateIso}

Source material (full assistant message):

<source>
${args.lastAssistantMessage}
</source>

Produce the Pensieve entry using the markdown section format above.`;
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

function saveParseFailure(raw: string, projectRoot: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment", "parse-failures");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${ts}.md`);
    fs.writeFileSync(file, raw, "utf8");
    logLine(projectRoot, `pensieve-writer parse:fail saved=${file}`);
  } catch { /* silent */ }
}

// ── Public ─────────────────────────────────────────────────────

export async function write(
  summary: string,
  lastAssistantMessage: string,
  projectRoot: string,
  registry: ModelRegistry,
  signal: AbortSignal | undefined,
): Promise<PensieveEntry | null> {
  const config = loadConfig(projectRoot);
  const tag = `pensieve-writer`;
  const dateIso = new Date().toISOString().slice(0, 10);

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
        systemPrompt: PENSIEVE_WRITE_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildPensieveWritePrompt({ summary, lastAssistantMessage, dateIso }) }],
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

    // Parse PENSIEVE section
    let clean = text.trim();
    const fenceMatch = clean.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
    if (!fenceMatch) {
      const fenceMatch2 = clean.match(/^```\s*\n([\s\S]*?)\n```\s*$/);
      if (fenceMatch2) clean = fenceMatch2[1];
    } else {
      clean = fenceMatch[1];
    }

    const headerRegex = /^#{2,3}\s+PENSIEVE\s*$/mi;
    const headerMatch = clean.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      saveParseFailure(text, projectRoot);
      return null;
    }

    const bodyStart = headerMatch.index + headerMatch[0].length;
    const nextHeader = clean.slice(bodyStart).match(/^#{2,3}\s+/m);
    const bodyEnd = nextHeader && nextHeader.index !== undefined
      ? bodyStart + nextHeader.index
      : clean.length;
    const raw = clean.slice(bodyStart, bodyEnd).trim();
    if (!raw) return null;

    const contentIdx = raw.search(/__CONTENT__/i);
    if (contentIdx === -1) return null;

    const header = raw.slice(0, contentIdx).trim();
    let content = raw.slice(contentIdx + "__CONTENT__".length).trim();
    if (!content || content.length < 100) return null;

    content = content.replace(/^\n+/, "");
    if (!content.startsWith("---")) return null;
    if (!/^type:\s*(knowledge|decision|maxim)/m.test(content)) return null;

    const kind = extractField(header, "kind") as "knowledge" | "decision" | "maxim" | null;
    if (!kind || !["knowledge", "decision", "maxim"].includes(kind)) return null;

    const slug = extractField(header, "slug");
    if (!slug) return null;

    const label = extractField(header, "label") || slug;

    logLine(projectRoot, `${tag} done: ${kind}/${slug}`);
    return { kind, slug, label, content };
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParent);
  }
}
