/**
 * pi-sediment scheduler — coalescing per-target checkpoint scheduler.
 *
 * This is not a FIFO queue. Each target keeps:
 *   lastProcessedEntryId → pendingHeadEntryId
 * and processes the whole conversation window between them.
 *
 * If new turns arrive while a target is running, only pendingHeadEntryId is
 * updated. When the current run finishes, the scheduler immediately processes
 * the newest pending window.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type RunResult = "processed" | "failed";

export interface BranchSnapshot {
  sessionId: string;
  projectRoot: string;
  headEntryId: string;
  entries: any[];
  /**
   * Live model registry from the most recent agent_end ctx.
   * MUST come from the ctx passed to the agent_end handler — not from a
   * captured session_start ctx. Captured ctx becomes stale after
   * session replacement/reload, and even property access on it throws.
   */
  modelRegistry: any;
}

export interface RunWindow {
  target: string;
  sessionId: string;
  projectRoot: string;
  fromEntryId: string | null;
  toEntryId: string;
  /** Timestamp/date of the source conversation head, used for timeline entries. */
  sourceTimestamp?: string;
  sourceDateIso?: string;
  text: string;
  entryCount: number;
  /** Live model registry, refreshed each markPending(). See BranchSnapshot. */
  modelRegistry: any;
}

type WorkerFn = (window: RunWindow) => Promise<RunResult>;

/**
 * Lifecycle phase observed by external listeners (typically the UI).
 * Scheduler is the single source of truth for what's happening per target;
 * callers should NOT compute or override phase from event handlers — they
 * just subscribe and react.
 *
 *   idle    → nothing pending, nothing running
 *   pending → work queued (either fresh markPending or retry-scheduled),
 *             not yet running
 *   running → worker is actively executing
 *
 * Transitions ("→ same" listed for completeness; same-state emits are
 * deduped by emitPhase and never reach listeners):
 *
 *   idle      → pending  : markPending() while worker not running
 *   idle      → running  : markPending() if buildRunWindow yields work synchronously (typical)
 *   pending   → running  : tick() picks up the queued window
 *   pending   → idle     : a same-tick buildRunWindow returns null AND nothing pending (rare)
 *   running   → idle     : worker finishes, no more pending
 *   running   → running  : (deduped) coalesced new pending consumed in same tick
 *   running   → pending  : worker finished but failed; scheduleRetry queued backoff timer
 *
 * The UI may see the cluster idle→pending→running collapse to a single
 * ⏳ frame because emit happens synchronously inside markPending; that's
 * intentional. Pending becomes visible when buildRunWindow can't build
 * (e.g., snapshot doesn't yet contain the head id), or while a
 * retry-backoff timer is waiting.
 */
export type SchedulerPhase = "idle" | "pending" | "running";

type PhaseListener = (target: string, phase: SchedulerPhase) => void;

type TargetDiskState = {
  lastProcessedEntryId: string | null;
  pendingHeadEntryId: string | null;
  retryCount?: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
};

type DiskState = {
  version: 1;
  targets: Record<string, TargetDiskState>;
};

type TargetState = TargetDiskState & {
  running: boolean;
  worker: WorkerFn | null;
  latestSnapshot: BranchSnapshot | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  phase: SchedulerPhase;
};

const states = new Map<string, TargetState>(); // target → state
const phaseListeners = new Set<PhaseListener>();

function emitPhase(target: string, state: TargetState, next: SchedulerPhase): void {
  if (state.phase === next) return;
  state.phase = next;
  for (const fn of phaseListeners) {
    try { fn(target, next); } catch { /* listener must not break scheduler */ }
  }
}

// ── Disk state ────────────────────────────────────────────────

function statePath(projectRoot: string): string {
  return path.join(projectRoot, ".pi-sediment", "state.json");
}

function readDisk(projectRoot: string): DiskState {
  try {
    const raw = fs.readFileSync(statePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed?.targets) return parsed as DiskState;
  } catch { /* first run */ }
  return { version: 1, targets: {} };
}

function writeDisk(projectRoot: string, state: DiskState): void {
  const dir = path.join(projectRoot, ".pi-sediment");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(projectRoot), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function loadTarget(projectRoot: string, target: string): TargetDiskState {
  const disk = readDisk(projectRoot);
  return disk.targets[target] ?? { lastProcessedEntryId: null, pendingHeadEntryId: null };
}

function saveTarget(projectRoot: string, target: string, patch: TargetDiskState): void {
  const disk = readDisk(projectRoot);
  disk.targets[target] = patch;
  writeDisk(projectRoot, disk);
}

// ── Window formatting ─────────────────────────────────────────

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function entryToText(entry: any): string | null {
  if (entry.type === "message") {
    const role = entry.message?.role ?? "message";
    const text = contentToText(entry.message?.content).trim();
    if (!text) return null;
    return `### ${role} (${entry.id})\n${text}`;
  }

  if (entry.type === "custom_message") {
    const text = contentToText(entry.content).trim();
    if (!text) return null;
    return `### custom_message:${entry.customType} (${entry.id})\n${text}`;
  }

  if (entry.type === "compaction") {
    return `### compaction (${entry.id})\n${entry.summary ?? ""}`.trim();
  }

  if (entry.type === "branch_summary") {
    return `### branch_summary (${entry.id})\n${entry.summary ?? ""}`.trim();
  }

  return null;
}

const MAX_ENTRY_CHARS = 12_000;
const MAX_WINDOW_CHARS = 80_000;

function buildWindowText(entries: any[]): string {
  const chunks: string[] = [];
  let total = 0;

  for (const entry of entries) {
    let text = entryToText(entry);
    if (!text) continue;
    if (text.length > MAX_ENTRY_CHARS) {
      text = text.slice(0, MAX_ENTRY_CHARS) + "\n[...entry truncated...]";
    }
    if (total + text.length > MAX_WINDOW_CHARS) {
      chunks.push("[...window truncated due to size...]");
      break;
    }
    chunks.push(text);
    total += text.length;
  }

  return chunks.join("\n\n---\n\n");
}

function isoDateFromTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function buildRunWindow(target: string, state: TargetState): RunWindow | null {
  const snapshot = state.latestSnapshot;
  if (!snapshot || !state.pendingHeadEntryId) return null;

  const entries = snapshot.entries;
  const headIdx = entries.findIndex((e) => e.id === state.pendingHeadEntryId);
  if (headIdx === -1) return null;
  const headEntry = entries[headIdx];
  const sourceTimestamp = typeof headEntry?.timestamp === "string" ? headEntry.timestamp : undefined;
  const sourceDateIso = isoDateFromTimestamp(sourceTimestamp);

  const lastIdx = state.lastProcessedEntryId
    ? entries.findIndex((e) => e.id === state.lastProcessedEntryId)
    : -1;
  const startIdx = lastIdx >= 0 ? lastIdx + 1 : 0;
  if (startIdx > headIdx) return null;

  const windowEntries = entries.slice(startIdx, headIdx + 1);
  const text = buildWindowText(windowEntries);
  if (!text.trim()) return null;

  return {
    target,
    sessionId: snapshot.sessionId,
    projectRoot: snapshot.projectRoot,
    fromEntryId: state.lastProcessedEntryId,
    toEntryId: state.pendingHeadEntryId,
    sourceTimestamp,
    sourceDateIso,
    text,
    entryCount: windowEntries.length,
    modelRegistry: snapshot.modelRegistry,
  };
}

// ── Scheduler loop ────────────────────────────────────────────

function getOrCreate(target: string): TargetState {
  let s = states.get(target);
  if (!s) {
    s = {
      lastProcessedEntryId: null,
      pendingHeadEntryId: null,
      retryCount: 0,
      running: false,
      worker: null,
      latestSnapshot: null,
      retryTimer: null,
      phase: "idle",
    };
    states.set(target, s);
  }
  return s;
}

function persist(state: TargetState, target: string): void {
  const projectRoot = state.latestSnapshot?.projectRoot;
  if (!projectRoot) return;
  saveTarget(projectRoot, target, {
    lastProcessedEntryId: state.lastProcessedEntryId,
    pendingHeadEntryId: state.pendingHeadEntryId,
    retryCount: state.retryCount,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  });
}

function scheduleRetry(target: string, state: TargetState): void {
  if (state.retryTimer) return;
  const retryCount = state.retryCount ?? 1;
  const delayMs = Math.min(60_000, 5_000 * Math.pow(2, Math.max(0, retryCount - 1)));
  // Phase stays "pending" while waiting for backoff timer — work is queued,
  // not idle. Otherwise the UI would falsely show idle during retry windows.
  emitPhase(target, state, "pending");
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    tick(target);
  }, delayMs);
}

function tick(target: string): void {
  const state = states.get(target);
  if (!state || state.running || !state.worker) return;

  const run = buildRunWindow(target, state);
  if (!run) {
    // No work buildable — if we just finished a run and pending == processed,
    // we're truly idle. Otherwise leave phase as caller set it.
    if (state.pendingHeadEntryId === state.lastProcessedEntryId && !state.retryTimer) {
      emitPhase(target, state, "idle");
    }
    return;
  }

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  emitPhase(target, state, "running");
  persist(state, target);

  void state.worker(run)
    .then((result) => {
      if (result === "processed") {
        state.lastProcessedEntryId = run.toEntryId;
        state.retryCount = 0;
        state.lastSuccessAt = new Date().toISOString();
        state.lastError = undefined;
        state.lastErrorAt = undefined;
      } else {
        state.retryCount = (state.retryCount ?? 0) + 1;
        state.lastError = "worker returned failed";
        state.lastErrorAt = new Date().toISOString();
      }
    })
    .catch((e) => {
      state.retryCount = (state.retryCount ?? 0) + 1;
      state.lastError = e?.message ?? String(e);
      state.lastErrorAt = new Date().toISOString();
    })
    .finally(() => {
      state.running = false;
      persist(state, target);
      // If new content arrived while running, process the coalesced pending head.
      // On failure, keep the checkpoint unchanged but retry with backoff — no busy loop.
      if (state.pendingHeadEntryId !== state.lastProcessedEntryId) {
        if ((state.retryCount ?? 0) > 0) {
          scheduleRetry(target, state); // emits "pending"
        } else {
          tick(target); // emits "running" if work runs, or "idle" via the no-work branch
        }
      } else {
        // Done and nothing pending — truly idle.
        emitPhase(target, state, "idle");
      }
    });
}

// ── Public ─────────────────────────────────────────────────────

export function registerScheduler(target: string, worker: WorkerFn): void {
  const state = getOrCreate(target);
  state.worker = worker;
  tick(target);
}

/**
 * Subscribe to phase changes for any target. Returns an unsubscribe fn.
 * Listener is fired only on transition (idle↔pending↔running), not on no-op
 * re-emits. Listener errors are swallowed so the scheduler can't be broken
 * by a buggy UI write.
 */
export function onPhaseChange(listener: PhaseListener): () => void {
  phaseListeners.add(listener);
  return () => { phaseListeners.delete(listener); };
}

/** Read current phase — used to seed the UI on registration. */
export function getPhase(target: string): SchedulerPhase {
  return states.get(target)?.phase ?? "idle";
}

export function markPending(target: string, snapshot: BranchSnapshot): void {
  const state = getOrCreate(target);

  // Load checkpoint lazily for this project root.
  if (!state.latestSnapshot || state.latestSnapshot.projectRoot !== snapshot.projectRoot) {
    const disk = loadTarget(snapshot.projectRoot, target);
    state.lastProcessedEntryId = disk.lastProcessedEntryId;
    state.pendingHeadEntryId = disk.pendingHeadEntryId;
    state.retryCount = disk.retryCount ?? 0;
    state.lastRunAt = disk.lastRunAt;
    state.lastSuccessAt = disk.lastSuccessAt;
    state.lastErrorAt = disk.lastErrorAt;
    state.lastError = disk.lastError;
  }

  state.latestSnapshot = snapshot;
  state.pendingHeadEntryId = snapshot.headEntryId;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  // Mark phase before tick. If tick can run synchronously, it will overwrite
  // "pending" with "running" — correct behavior. If tick can't run (worker
  // already running, or no work buildable yet), "pending" stays visible so
  // the UI shows ⏱ instead of stale running/idle.
  if (!state.running) emitPhase(target, state, "pending");
  persist(state, target);
  tick(target);
}
