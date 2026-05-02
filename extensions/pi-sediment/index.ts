/**
 * pi-sediment extension — unified auto-sediment engine.
 *
 * Lifecycle:
 *   session_start  → detect targets (Pensieve + gbrain), update status bar
 *   before_agent_start → re-detect targets (gbrain may come online mid-session)
 *   agent_end      → push last_assistant_message to queue (non-blocking)
 *
 * Worker (detached async, sequential):
 *   evaluate → skip → next
 *   evaluate → sediment → write (single call, dual output)
 *     → Promise.all([writeToPensieve, writeToGbrainWithRetry]) → next
 *     gbrain failures trigger up to 2 retries; non-Latin content gets
 *     LLM-translated to English before retry
 *
 * Key design:
 *   - No regex pre-filtering — model decides everything
 *   - In-process sidecar — 0 token / 0 latency / 0 context pollution
 *   - Queue max 20 — prevents memory leaks, drops oldest when full
 *   - Cold-start hint — gbrain < 10 pages → evaluator more aggressive
 *   - Both writes must complete before consuming next queue item
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { detectTargets } from "./detector.js";
import { enqueue, startWorker, clearSession } from "./queue.js";
import { evaluate } from "./evaluator.js";
import { write } from "./writer.js";
import { writeToPensieve } from "./targets/pensieve.js";
import { writeToGbrainWithRetry, type GbrainTranslateFn } from "./targets/gbrain.js";
import { loadConfig } from "./config.js";
import { completeSimple } from "@mariozechner/pi-ai";
import type { QueueItem, TargetStatus } from "./types.js";
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

// ── gbrain translation ─────────────────────────────────────────

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

    // Parse: first line is title, rest is body
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

// ── Worker callback ────────────────────────────────────────────

async function processItem(item: QueueItem, ctx: any): Promise<void> {
  // 1. Evaluate
  const evalResult = await evaluate(
    item.lastAssistantMessage,
    item.targets,
    item.projectRoot,
    ctx.modelRegistry,
    item.signal,
  );

  if (evalResult.decision === "skip") return;

  // Status: writing
  if (ctx.hasUI) {
    try { ctx.ui.setStatus("pi-sediment", "⏳ sediment: writing..."); } catch {}
  }

  // 2. Write (single call, dual output)
  const writeResult = await write(
    evalResult.summary,
    item.lastAssistantMessage,
    item.projectRoot,
    ctx.modelRegistry,
    item.signal,
  );

  if (!writeResult.pensieve && !writeResult.gbrain) {
    if (ctx.hasUI) {
      try { ctx.ui.setStatus("pi-sediment", formatStatus(item.targets)); } catch {}
    }
    return;
  }

  // 3. Build translate callback (for non-Latin gbrain content that fails)
  const translateFn: GbrainTranslateFn = writeResult.gbrain
    ? async (entry, attempt) => translateGbrainEntry(entry, item.projectRoot, ctx.modelRegistry)
    : async () => null;

  // 4. Write to targets — parallel, both must complete
  const results = await Promise.all([
    writeResult.pensieve && item.targets.pensieve
      ? writeToPensieve(writeResult.pensieve, item.projectRoot).then((ok) => ({ target: "pensieve" as const, ok, label: writeResult.pensieve!.label }))
      : Promise.resolve(null),
    writeResult.gbrain && item.targets.gbrain
      ? writeToGbrainWithRetry(writeResult.gbrain, item.projectRoot, translateFn).then((ok) => ({ target: "gbrain" as const, ok, label: writeResult.gbrain!.title }))
      : Promise.resolve(null),
  ]);

  // Log results
  const writtenParts: string[] = [];
  for (const r of results) {
    if (!r) continue;
    const status = r.ok ? "✓" : "✗";
    writtenParts.push(`${r.target}:${status}`);
  }
  if (writtenParts.length > 0) {
    logLine(item.projectRoot, `sediment done: ${writtenParts.join(" ")}`);
  }

  // Revert status bar
  if (ctx.hasUI) {
    try { ctx.ui.setStatus("pi-sediment", formatStatus(item.targets)); } catch {}
  }

  // 4. Notify (non-blocking, one line)
  const labels: string[] = [];
  if (writeResult.pensieve && item.targets.pensieve) {
    labels.push(`pensieve:${writeResult.pensieve.label.slice(0, 40)}`);
  }
  if (writeResult.gbrain && item.targets.gbrain) {
    labels.push(`gbrain:${writeResult.gbrain.title.slice(0, 40)}`);
  }
  if (labels.length > 0 && ctx.hasUI) {
    try {
      ctx.ui.notify(`sedimented → ${labels.join(" | ")}`, "info");
    } catch { /* print mode */ }
  }
}

// ── Extension entry ────────────────────────────────────────────

export default function piSediment(pi: ExtensionAPI) {
  let targets: TargetStatus = { pensieve: false, gbrain: false, gbrainPageCount: null };
  const sessionStates = new Map<string, { targets: TargetStatus; cwd: string }>();

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
    // Only update if something changed (e.g., gbrain came online)
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
    clearSession(sid);
    sessionStates.delete(sid);
  });

  // ── agent_end: push to queue ───────────────────────────────
  pi.on("agent_end", async (_event: AgentEndEvent, ctx) => {
    if (!targets.pensieve && !targets.gbrain) return;

    const sid = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
    const cwd = ctx.cwd;

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
      signal: ctx.signal,
    };

    enqueue(sid, item);

    // Start worker if not already running (pass ctx-like interface)
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
