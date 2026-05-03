/**
 * pi-sediment extension — per-target auto-sediment engine.
 *
 * Lifecycle:
 *   session_start  → detect targets (Pensieve + gbrain), update status bar
 *   before_agent_start → re-detect targets (gbrain may come online mid-session)
 *   agent_end      → push last_assistant_message to queue (non-blocking)
 *
 * Worker (detached async, parallel per-target pipelines):
 *
 *   Pensieve pipeline:
 *     evaluator (Pensieve criteria) → writer → writeToPensieve
 *
 *   gbrain pipeline:
 *     evaluateForGbrain → searchGbrainForLinks → writeForGbrain (with wikilinks + timeline) → gbrain put
 *
 * Key design:
 *   - Per-target evaluation — each target decides independently
 *   - gbrain writer includes [[wikilink]] cross-references and timeline entries
 *   - Injection filter on all LLM-generated content
 *   - In-process sidecar — 0 token / 0 latency / 0 context pollution
 *   - Queue max 20 — prevents memory leaks, drops oldest when full
 *
 * Future: Pensieve will delegate to /skill:pensieve self-improve once extension-to-skill
 * invocation is available. For now, Pensieve keeps its internal evaluator+writer.
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { detectTargets } from "./detector.js";
import { enqueue, startWorker, clearSession } from "./queue.js";
import { evaluateForGbrain } from "./evaluator.js";
import { writeForGbrain } from "./writer.js";
import { searchGbrainForLinks, writeToGbrainWithRetry, type GbrainTranslateFn } from "./targets/gbrain.js";
import { writeToPensieve } from "./targets/pensieve.js";
import { loadConfig } from "./config.js";
import { completeSimple } from "@mariozechner/pi-ai";
import type { QueueItem, TargetStatus, GbrainWriteOutput, GbrainWriteInput } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Extract text from assistant message ────────────────────────

function logLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* silent */ }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// ── Status bar ─────────────────────────────────────────────────

function formatStatus(targets: TargetStatus): string {
  const parts: string[] = [];
  if (targets.pensieve) parts.push("pensieve");
  if (targets.gbrain) parts.push("gbrain");
  if (parts.length === 0) return "⏳ sediment: no targets";
  return `⏳ sediment → ${parts.join("+")}`;
}

// ── gbrain translation (non-Latin → English retry) ──────────────

const TRANSLATE_SYSTEM_PROMPT = `You are a technical translator. Your ONLY job is to translate the given technical content to English.

Rules:
- Preserve ALL technical accuracy, terms, and code references
- Keep the same structure (sections, lists, etc.)
- Output ONLY the translated content, no preamble or commentary
- Both the title and body must be in English`;

async function translateGbrainEntry(
  entry: { title: string; tags: string[]; content: string },
  projectRoot: string,
  registry: any,
): Promise<{ title: string; tags: string[]; content: string } | null> {
  const config = loadConfig(projectRoot);
  const model = registry.find(config.model.provider, config.model.modelId);
  if (!model) return null;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), 30_000);

  try {
    const prompt = [
      "Translate the following technical content to English.",
      "",
      `Title: ${entry.title}`,
      "",
      "Body:",
      entry.content,
    ].join("\n");

    const response = await completeSimple(
      model,
      {
        systemPrompt: TRANSLATE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ac.signal,
        maxTokens: 8192,
        ...(config.reasoning !== "off" ? { reasoning: config.reasoning } : {}),
      },
    );

    if (response.stopReason !== "complete") return null;

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const lines = text.trim().split("\n");
    const engTitle = lines[0]?.replace(/^#+\s*/, "").trim();
    const engBody = lines.slice(1).join("\n").trim();

    if (!engTitle || !engBody) return null;

    return {
      title: engTitle.slice(0, 200),
      tags: entry.tags,
      content: engBody,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Pensieve pipeline (internal evaluator+writer for now) ──────

async function runPensievePipeline(
  item: QueueItem,
  ctx: any,
): Promise<{ ok: boolean; label: string } | null> {
  if (!item.targets.pensieve) return null;

  // For now, keep the existing Pensieve evaluator+writer path.
  // TODO: delegate to /skill:pensieve self-improve when extension-to-skill
  // invocation becomes available in pi.
  const { evaluate } = await import("./evaluator-pensieve.js");
  const { write: writePensieveEntry } = await import("./writer-pensieve.js");

  const evalResult = await evaluate(
    item.lastAssistantMessage,
    item.projectRoot,
    ctx.modelRegistry,
    item.signal,
  );

  if (evalResult.decision === "skip") return null;

  const writeResult = await writePensieveEntry(
    evalResult.summary,
    item.lastAssistantMessage,
    item.projectRoot,
    ctx.modelRegistry,
    item.signal,
  );

  if (!writeResult) return null;

  const ok = await writeToPensieve(writeResult, item.projectRoot);
  return { ok, label: writeResult.label };
}

// ── gbrain pipeline (new: evaluate → search → write with wikilinks) ──

async function runGbrainPipeline(
  item: QueueItem,
  ctx: any,
): Promise<{ ok: boolean; label: string } | null> {
  if (!item.targets.gbrain) return null;

  // 1. Evaluate: is this a universal engineering principle?
  const evalResult = await evaluateForGbrain(
    item.lastAssistantMessage,
    item.targets,
    item.projectRoot,
    ctx.modelRegistry,
    item.signal,
  );

  if (evalResult.decision === "skip") return null;

  // 2. Search gbrain for related pages (for [[wikilink]] cross-references)
  const relatedPages = await searchGbrainForLinks(evalResult.summary, item.projectRoot);

  // 3. Write: generate gbrain markdown with wikilinks and timeline
  const dateIso = new Date().toISOString().slice(0, 10);
  const writeInput: GbrainWriteInput = {
    summary: evalResult.summary,
    dateIso,
    lastAssistantMessage: item.lastAssistantMessage,
    relatedPages,
  };

  const writeResult = await writeForGbrain(
    writeInput,
    item.projectRoot,
    ctx.modelRegistry,
    item.signal,
  );

  if (!writeResult) return null;

  // 4. Build translation callback for non-Latin content retry
  const translateFn: GbrainTranslateFn = writeResult
    ? async (entry, attempt) => translateGbrainEntry(entry, item.projectRoot, ctx.modelRegistry)
    : async () => null;

  // 5. Write to gbrain (with retry + translation fallback)
  const ok = await writeToGbrainWithRetry(writeResult, item.projectRoot, translateFn);
  return { ok, label: writeResult.title };
}

// ── Worker callback ────────────────────────────────────────────

async function processItem(item: QueueItem, ctx: any): Promise<void> {
  // Status: evaluating
  if (ctx.hasUI) {
    try { ctx.ui.setStatus("pi-sediment", "⏳ sediment: evaluating..."); } catch {}
  }

  // Run Pensieve and gbrain pipelines in parallel
  const results = await Promise.all([
    runPensievePipeline(item, ctx),
    runGbrainPipeline(item, ctx),
  ]);

  // Log results
  const writtenParts: string[] = [];
  for (const r of results) {
    if (!r) continue;
    const status = r.ok ? "✓" : "✗";
    writtenParts.push(`${status}`);
  }
  if (writtenParts.length > 0) {
    logLine(item.projectRoot, `sediment done: pensieve=${writtenParts[0] || "-"} gbrain=${writtenParts[1] || "-"}`);
  }

  // Notify
  const labels: string[] = [];
  for (const r of results) {
    if (r) labels.push(r.label.slice(0, 40));
  }
  if (labels.length > 0 && ctx.hasUI) {
    try {
      ctx.ui.notify(`sedimented → ${labels.join(" | ")}`, "info");
    } catch { /* print mode */ }
  }

  // Revert status bar
  if (ctx.hasUI) {
    try { ctx.ui.setStatus("pi-sediment", formatStatus(item.targets)); } catch {}
  }
}

// ── Extension entry ────────────────────────────────────────────

export default function piSediment(pi: ExtensionAPI) {
  let targets: TargetStatus = { pensieve: false, gbrain: false, gbrainPageCount: null };
  const sessionStates = new Map<string, { targets: TargetStatus; cwd: string }>();
  const sessionAbortControllers = new Map<string, AbortController>();

  // ── session_start: detect targets ──────────────────────────
  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    const sid = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
    targets = await detectTargets(ctx.cwd);
    sessionStates.set(sid, { targets: { ...targets }, cwd: ctx.cwd });
    if (ctx.hasUI) {
      try { ctx.ui.setStatus("pi-sediment", formatStatus(targets)); } catch {}
    }
  });

  // ── before_agent_start: re-detect (gbrain may come online) ─
  pi.on("before_agent_start", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
    const fresh = await detectTargets(ctx.cwd);
    const prev = sessionStates.get(sid);
    if (!prev || prev.targets.gbrain !== fresh.gbrain || prev.targets.pensieve !== fresh.pensieve) {
      targets = fresh;
      sessionStates.set(sid, { targets: { ...fresh }, cwd: ctx.cwd });
    }
    if (ctx.hasUI) {
      try { ctx.ui.setStatus("pi-sediment", formatStatus(targets)); } catch {}
    }
  });

  // ── session_shutdown: cleanup ────────────────────────────
  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx) => {
    const sid = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
    const ctrl = sessionAbortControllers.get(sid);
    if (ctrl) {
      ctrl.abort();
      sessionAbortControllers.delete(sid);
    }
    clearSession(sid);
    sessionStates.delete(sid);
  });

  // ── agent_end: push to queue ───────────────────────────────
  pi.on("agent_end", async (_event: AgentEndEvent, ctx) => {
    if (!targets.pensieve && !targets.gbrain) return;

    const sid = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
    const cwd = ctx.cwd;

    let ctrl = sessionAbortControllers.get(sid);
    if (!ctrl || ctrl.signal.aborted) {
      ctrl = new AbortController();
      sessionAbortControllers.set(sid, ctrl);
    }

    // Extract last assistant message
    const branch = ctx.sessionManager.getBranch();
    const lastAssistant = [...branch]
      .reverse()
      .find((e) => e.type === "message" && e.message?.role === "assistant");
    if (!lastAssistant || lastAssistant.type !== "message") return;
    const lastMsg = extractText(lastAssistant.message.content);
    if (!lastMsg) return;

    const item: QueueItem = {
      sessionId: sid,
      lastAssistantMessage: lastMsg,
      projectRoot: cwd,
      targets: { ...targets },
      cwd,
      signal: ctrl.signal,
    };

    enqueue(sid, item);

    startWorker(sid, async (qItem: QueueItem) => {
      const state = sessionStates.get(qItem.sessionId);
      if (!state) return;
      const ctxStub = {
        modelRegistry: ctx.modelRegistry,
        signal: qItem.signal,
        hasUI: ctx.hasUI,
        ui: ctx.ui,
      };
      await processItem(qItem, ctxStub);
    });
  });
}
