/**
 * pi-sediment gbrain target — write to gbrain via CLI.
 *
 * Uses `gbrain put <slug> --title <title> --tags <tags>` with content on stdin.
 * Throttle/rate-limit → silent downgrade (deferred).
 * gbrain unavailable → silent skip.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeSlug } from "../utils.js";
import type { GbrainEntry } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────

function throttleErr(stderr: string): boolean {
  const kw = ["throttle", "rate limit", "capacity", "busy"];
  return kw.some((k) => stderr.toLowerCase().includes(k));
}

function logLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* silent */ }
}

// ── Public ─────────────────────────────────────────────────────

export async function writeToGbrain(
  entry: GbrainEntry,
  projectRoot: string,
): Promise<boolean> {
  const slug = sanitizeSlug(entry.title);
  if (!slug) return false;

  const args = [
    "put", slug,
    "--title", entry.title,
    "--tags", entry.tags.join(","),
  ];

  return new Promise((resolve) => {
    const child = spawn("gbrain", args, {
      cwd: `${process.env.HOME}/gbrain`,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      logLine(projectRoot, `gbrain write:timeout slug=${slug}`);
      resolve(false);
    }, 15_000);

    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    // stdout consumed but not used
    child.stdout.on("data", () => {});

    child.on("error", (e) => {
      clearTimeout(timer);
      logLine(projectRoot, `gbrain write:error slug=${slug} ${e.message}`);
      resolve(false);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logLine(projectRoot, `gbrain write:ok slug=${slug}`);
        resolve(true);
      } else if (throttleErr(stderr)) {
        logLine(projectRoot, `gbrain write:throttle slug=${slug} → deferred`);
        resolve(true);
      } else {
        logLine(projectRoot, `gbrain write:fail slug=${slug} code=${code} ${stderr.slice(0, 200)}`);
        resolve(false);
      }
    });

    // Write content to stdin and close — must happen after listeners are set up
    child.stdin.write(entry.content);
    child.stdin.end();
  });
}
