/**
 * pi-sediment detector — auto-detect available targets.
 *
 * Pensieve:  .pensieve/ dir exists in project root → true
 * gbrain:    `gbrain doctor --json` exits 0 → true
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TargetStatus } from "./types.js";

const execFileP = promisify(execFile);

// ── Pensieve detection ─────────────────────────────────────────

function detectPensieve(projectRoot: string): boolean {
  const dir = path.join(projectRoot, ".pensieve");
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ── gbrain detection ───────────────────────────────────────────

interface GbrainDoctor {
  status?: string;
  health_score?: number;
  page_count?: number;
}

async function detectGbrain(): Promise<{ available: boolean; pageCount: number | null }> {
  try {
    const { stdout, stderr } = await execFileP("gbrain", ["doctor", "--json"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      cwd: `${process.env.HOME}/gbrain`,
    });
    if (!stdout) return { available: false, pageCount: null };
    const doc = JSON.parse(stdout.trim()) as GbrainDoctor;
    const pageCount = typeof doc.page_count === "number" ? doc.page_count : null;
    return { available: true, pageCount };
  } catch {
    return { available: false, pageCount: null };
  }
}

// ── Public ─────────────────────────────────────────────────────

export async function detectTargets(projectRoot: string): Promise<TargetStatus> {
  const pensieve = detectPensieve(projectRoot);
  const gbrain = await detectGbrain();

  return {
    pensieve,
    gbrain: gbrain.available,
    gbrainPageCount: gbrain.pageCount,
  };
}
