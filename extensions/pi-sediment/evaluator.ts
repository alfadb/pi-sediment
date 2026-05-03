/**
 * pi-sediment gbrain evaluator — calls model to decide skip/sediment.
 *
 * Pensieve evaluation is delegated to /skill:pensieve self-improve.
 * This module handles gbrain only: "is this a universal engineering principle?"
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRef, loadConfig, type SedimentConfig } from "./config.js";
import { GBRAIN_EVAL_PROMPT, buildGbrainEvalPrompt } from "./prompts.js";
import type { GbrainEvalResult, ResolvedModel, TargetStatus } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────

async function resolveModel(
  config: SedimentConfig,
  registry: ModelRegistry,
): Promise<ResolvedModel | { error: string }> {
  const m = registry.find(config.model.provider, config.model.modelId);
  if (!m) return { error: `model not found: ${formatModelRef(config.model)}` };
  const auth = await registry.getApiKeyAndHeaders(m);
  if (!auth.ok) return { error: `auth failed: ${auth.error}` };
  if (!auth.apiKey) return { error: "no api key" };
  return { model: m, apiKey: auth.apiKey, headers: auth.headers, display: formatModelRef(config.model) };
}

function extractEvalJson(text: string): GbrainEvalResult | null {
  let body = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1];
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  if (open === -1 || close === -1 || close <= open) return null;
  let parsed: any;
  try { parsed = JSON.parse(body.slice(open, close + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.decision !== "skip" && parsed.decision !== "sediment") return null;
  return {
    decision: parsed.decision as "skip" | "sediment",
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
  };
}

function logLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, ".pi-sediment");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* silent */ }
}

// ── Public ─────────────────────────────────────────────────────

export async function evaluateForGbrain(
  lastAssistantMessage: string,
  targets: TargetStatus,
  projectRoot: string,
  registry: ModelRegistry,
  _signal?: AbortSignal | undefined,
): Promise<GbrainEvalResult> {
  const config = loadConfig(projectRoot);
  const tag = `gbrain-evaluator`;

  const resolved = await resolveModel(config, registry);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return { decision: "skip", summary: "" };
  }

  const gbrainColdStart = targets.gbrain && (targets.gbrainPageCount ?? 999) < 10;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.evalTimeoutMs);

  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: GBRAIN_EVAL_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildGbrainEvalPrompt({ lastAssistantMessage, gbrainColdStart }) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        signal: ac.signal,
        maxTokens: 512,
      },
    );

    if (response.stopReason === "error") {
      logLine(projectRoot, `${tag} call:error ${response.errorMessage || "unknown"}`);
      return { decision: "skip", summary: "" };
    }
    if (response.stopReason === "aborted") {
      logLine(projectRoot, `${tag} call:aborted`);
      return { decision: "skip", summary: "" };
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const result = extractEvalJson(text);
    if (!result) {
      logLine(projectRoot, `${tag} parse:fail rawlen=${text.length}`);
      return { decision: "skip", summary: "" };
    }

    logLine(projectRoot, `${tag} decision:${result.decision} summary="${result.summary.slice(0, 120)}"`);
    return result;
  } catch (e: any) {
    logLine(projectRoot, `${tag} exception:${e?.message ?? String(e)}`);
    return { decision: "skip", summary: "" };
  } finally {
    clearTimeout(timer);
  }
}
