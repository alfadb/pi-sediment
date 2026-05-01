/**
 * pi-sediment queue — in-memory sequential worker (max 20 items).
 *
 * agent_end fires → push message to tail, non-blocking.
 * Single worker consumes sequentially:
 *   evaluate → skip → next
 *   evaluate → sediment → write → Promise.all([pensieve, gbrain]) → next
 *
 * Queue cap: 20 items. Full → drop oldest unprocessed.
 * Cleared on session end.
 */

import type { QueueItem } from "./types.js";

type WorkerFn = (item: QueueItem) => Promise<void>;

// ── Module state ────────────────────────────────────────────────

const MAX_SIZE = 20;
const queues = new Map<string, QueueItem[]>();
const workers = new Map<string, boolean>(); // sessionId → isRunning

// ── Public ─────────────────────────────────────────────────────

export function enqueue(sessionId: string, item: QueueItem): void {
  let q = queues.get(sessionId);
  if (!q) {
    q = [];
    queues.set(sessionId, q);
  }
  q.push(item);
  // Drop oldest if exceeding max
  while (q.length > MAX_SIZE) {
    q.shift();
  }
}

export function startWorker(sessionId: string, fn: WorkerFn): void {
  if (workers.get(sessionId)) return; // already running
  workers.set(sessionId, true);

  void (async () => {
    while (true) {
      const q = queues.get(sessionId);
      if (!q || q.length === 0) break;
      const item = q.shift()!;
      try {
        await fn(item);
      } catch {
        // worker callback handles its own errors
      }
    }
    workers.delete(sessionId);
    queues.delete(sessionId);
  })();
}

export function clearSession(sessionId: string): void {
  queues.delete(sessionId);
  workers.delete(sessionId);
}
