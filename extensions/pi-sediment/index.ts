/**
 * pi-sediment extension — automatic insight capture engine.
 *
 * Architecture:
 *   - agent_end only marks each target's pending head entry.
 *   - Each target has an independent checkpoint scheduler, not a FIFO queue.
 *   - A run evaluates the whole window from lastProcessedEntryId to pendingHeadEntryId.
 *   - New turns arriving during a run coalesce into the next pending window.
 *   - Workers are never interrupted by the main session; only internal timeouts apply.
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { detectTargets } from "./detector.js";
import { registerScheduler, markPending, type RunResult, type RunWindow } from "./scheduler.js";
import { evaluateForGbrain } from "./evaluator.js";
import {
  writeForGbrain,
  isParseFailure,
  buildFormatError,
  type WriteResult,
} from "./writer.js";
import {
  searchGbrainForLinks,
  writeToGbrainWithRetry,
  type GbrainTranslateFn,
} from "./targets/gbrain.js";
import { writePensieve } from "./pensieve-writer.js";
import { loadConfig } from "./config.js";
import { completeSimple } from "@mariozechner/pi-ai";
import type { TargetStatus, GbrainWriteInput } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Helpers ────────────────────────────────────────────────────

function logLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* silent */ }
}

const STATUS_PENSIEVE = "pi-sediment-pensieve";
const STATUS_GBRAIN = "pi-sediment-gbrain";
const STATUS_LEGACY = "pi-sediment";

function setStatus(ctx: any, key: string, value: string | undefined): void {
  // Defensive: ctx may be stale (session replaced/reloaded since session_start
  // captured this closure). Even reading ctx.hasUI on a stale ctx throws —
  // so the guard must live INSIDE the try, not outside it. If this throws in
  // a worker's finally{} block, the whole promise rejects and the scheduler
  // re-runs the same window (causing duplicate writes + ever-growing
  // retryCount in .pi-sediment/state.json).
  try {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(key, value);
  } catch { /* stale ctx / print / rpc mode */ }
}

// ── gbrain translation (non-Latin → English) ────────────────────

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
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
      return null;
    }

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const lines = text.trim().split("\n");
    const engTitle = lines[0]?.replace(/^#+\s*/, "").trim();
    const engBody = lines.slice(1).join("\n").trim();

    if (!engTitle || !engBody) return null;

    const { sanitizeContent } = await import("./prompts.js");
    const safeContent = sanitizeContent(engBody);
    if (!safeContent) {
      logLine(projectRoot, `gbrain translate: rejected (injection pattern)`);
      return null;
    }

    return {
      title: engTitle.slice(0, 200),
      tags: entry.tags,
      content: safeContent,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── gbrain pipeline (with parse:fail retry) ────────────────────

const MAX_GBRAIN_RETRIES = 2;

async function processGbrain(
  window: RunWindow,
  targets: TargetStatus,
  registry: any,
): Promise<RunResult> {
  logLine(window.projectRoot, `gbrain window: entries=${window.entryCount} from=${window.fromEntryId ?? "START"} to=${window.toEntryId}`);

  // 1. Evaluate the whole checkpoint window.
  const evalResult = await evaluateForGbrain(
    window.text,
    targets,
    window.projectRoot,
    registry,
    undefined,
  );

  if (evalResult.decision === "skip") return "processed";

  // 2. Search related pages.
  const relatedPages = await searchGbrainForLinks(evalResult.summary, window.projectRoot);

  // 3. Write with retry on parse failure. Use the source conversation
  // timestamp, not writer wall-clock time; retries/backoff may run later.
  const dateIso = window.sourceDateIso ?? new Date().toISOString().slice(0, 10);
  let writeInput: GbrainWriteInput = {
    summary: evalResult.summary,
    dateIso,
    lastAssistantMessage: window.text,
    relatedPages,
  };

  let writeResult: WriteResult | null = null;
  for (let attempt = 0; attempt <= MAX_GBRAIN_RETRIES; attempt++) {
    writeResult = await writeForGbrain(writeInput, window.projectRoot, registry);
    if (!writeResult) {
      logLine(window.projectRoot, `gbrain pipeline: write failed (API error/abort) attempt=${attempt}`);
      return "failed";
    }
    if (!isParseFailure(writeResult)) break;

    const formatError = buildFormatError(writeResult.rawText);
    writeInput = { ...writeInput, formatError };
    logLine(window.projectRoot, `gbrain pipeline: parse fail, retry ${attempt + 1}/${MAX_GBRAIN_RETRIES}`);
  }

  if (!writeResult || isParseFailure(writeResult)) {
    logLine(window.projectRoot, `gbrain pipeline: parse fail exhausted retries`);
    return "failed";
  }

  // 4. Write to gbrain CLI.
  const translateFn: GbrainTranslateFn = async (entry, attempt) =>
    translateGbrainEntry(entry, window.projectRoot, registry);

  const ok = await writeToGbrainWithRetry(writeResult.output, window.projectRoot, translateFn);
  logLine(window.projectRoot, `sediment done: gbrain=${ok ? "✓" : "✗"}`);
  return ok ? "processed" : "failed";
}

// ── Pensieve pipeline (single LLM call: evaluate + write) ─────

async function processPensieve(
  window: RunWindow,
  registry: any,
): Promise<RunResult> {
  logLine(window.projectRoot, `pensieve window: entries=${window.entryCount} from=${window.fromEntryId ?? "START"} to=${window.toEntryId}`);

  const status = await writePensieve(window.text, window.projectRoot, registry);
  if (status === "written") {
    logLine(window.projectRoot, `sediment done: pensieve=✓`);
    return "processed";
  }
  if (status === "skipped") {
    return "processed";
  }

  logLine(window.projectRoot, `sediment done: pensieve=✗`);
  return "failed";
}

// ── Extension entry ────────────────────────────────────────────

export default function piSediment(pi: ExtensionAPI) {
  let targets: TargetStatus = {
    pensieve: false,
    gbrain: false,
    gbrainPageCount: null,
  };
  // Live ctx, refreshed on session_start and agent_end. Workers reference
  // this via closure; setStatus is defensive against staleness anyway.
  let lastCtx: any = null;

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    targets = await detectTargets(ctx.cwd);

    setStatus(ctx, STATUS_LEGACY, undefined);

    // CRITICAL: worker closures must NOT capture `ctx`. The ctx supplied to
    // session_start becomes stale once the host swaps sessions (newSession,
    // fork, switchSession, reload), and any property access on a stale ctx
    // throws. Workers run inside the scheduler's promise chain, so a throw
    // there is interpreted as worker failure — retryCount climbs forever
    // even though the actual write may have succeeded on a previous tick.
    //
    // Instead, we read modelRegistry off `window`, which is rebuilt from the
    // most recent agent_end ctx (see markPending below). Status writes use
    // module-level `lastCtx`, refreshed on every agent_end.
    lastCtx = ctx;

    if (targets.pensieve) {
      setStatus(lastCtx, STATUS_PENSIEVE, undefined);
      registerScheduler("pensieve", async (window: RunWindow) => {
        setStatus(lastCtx, STATUS_PENSIEVE, "⏳ Pz");
        try {
          return await processPensieve(window, window.modelRegistry);
        } finally {
          setStatus(lastCtx, STATUS_PENSIEVE, undefined);
        }
      });
    } else {
      setStatus(lastCtx, STATUS_PENSIEVE, undefined);
    }

    if (targets.gbrain) {
      setStatus(lastCtx, STATUS_GBRAIN, undefined);
      registerScheduler("gbrain", async (window: RunWindow) => {
        setStatus(lastCtx, STATUS_GBRAIN, "⏳ Gb");
        try {
          return await processGbrain(window, targets, window.modelRegistry);
        } finally {
          setStatus(lastCtx, STATUS_GBRAIN, undefined);
        }
      });
    } else {
      setStatus(lastCtx, STATUS_GBRAIN, undefined);
    }
  });

  pi.on("agent_end", async (_event: AgentEndEvent, ctx) => {
    // Refresh module-level live ctx so worker setStatus calls don't touch a
    // stale session_start ctx.
    lastCtx = ctx;

    if (!targets.pensieve && !targets.gbrain) return;

    const branch = ctx.sessionManager.getBranch();
    const head = branch[branch.length - 1];
    if (!head?.id) return;

    const snapshot = {
      sessionId: ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? "ephemeral",
      projectRoot: ctx.cwd,
      headEntryId: head.id,
      entries: branch,
      // Snapshot the live registry; workers will use this instead of any
      // ctx captured at session_start (which would be stale after reloads).
      modelRegistry: ctx.modelRegistry,
    };

    if (targets.pensieve) {
      setStatus(ctx, STATUS_PENSIEVE, "⏱ Pz");
      markPending("pensieve", snapshot);
    }
    if (targets.gbrain) {
      setStatus(ctx, STATUS_GBRAIN, "⏱ Gb");
      markPending("gbrain", snapshot);
    }
  });
}
