/**
 * pi-sediment Pensieve evaluator — calls model to decide skip/sediment.
 *
 * Evaluates whether the conversation turn contains a PROJECT-SPECIFIC insight
 * worth saving to Pensieve (file paths, module boundaries, architectural decisions).
 *
 * TODO: When extension-to-skill invocation is available in pi, this will be
 * replaced by /skill:pensieve self-improve delegation.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRef, loadConfig, type SedimentConfig } from "./config.js";
import type { ResolvedModel } from "./types.js";

// ── Pensieve evaluator prompt ────────────────────────────────────

const PENSIEVE_EVAL_PROMPT = `You are the pi-sediment Pensieve evaluator.

Read the FINAL assistant message of a coding-agent turn and decide whether
it contains a PROJECT-SPECIFIC insight worth saving to Pensieve.

Pensieve stores project-level knowledge — file locations, module boundaries,
call chains, architectural decisions, and project-specific conventions. Do
NOT store universal engineering principles (those go to gbrain).

Output ONLY a JSON block, nothing else:

{
  "decision": "skip" | "sediment",
  "summary": "one sentence describing the insight (empty if skip)"
}

Sediment when:
- An explicit architectural choice was made between alternatives
- A bug root cause was definitively identified (symptom → root → fix chain)
- A module boundary, call chain, or file location was discovered
- A project-specific convention or pattern was established
- A non-obvious pitfall specific to this codebase was found

Skip when:
- The turn is pure execution of a previously-decided plan
- Routine implementation: formatting, renaming, dependency bumps, simple fixes
- Status updates, asking user questions, or exploration without conclusion
- The content is obvious or already well-known
- The insight is a universal principle, not project-specific

Be conservative. False positives pollute memory. When in doubt, skip.`;

function buildPensieveEvalPrompt(lastAssistantMessage: string): string {
  return `Evaluate this assistant message and emit the JSON decision.

<assistant-message>
${lastAssistantMessage}
</assistant-message>`;
}

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

interface PensieveEvalResult {
  decision: "skip" | "sediment";
  summary: string;
}

function extractEvalJson(text: string): PensieveEvalResult | null {
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

export async function evaluate(
  lastAssistantMessage: string,
  projectRoot: string,
  registry: ModelRegistry,
  signal: AbortSignal | undefined,
): Promise<PensieveEvalResult> {
  const config = loadConfig(projectRoot);
  const tag = `pensieve-evaluator`;

  const resolved = await resolveModel(config, registry);
  if ("error" in resolved) {
    logLine(projectRoot, `${tag} model:error ${resolved.error}`);
    return { decision: "skip", summary: "" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.evalTimeoutMs);
  const onParent = () => ac.abort(new Error("parent aborted"));
  signal?.addEventListener("abort", onParent, { once: true });

  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: PENSIEVE_EVAL_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildPensieveEvalPrompt(lastAssistantMessage) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        signal: ac.signal,
        maxTokens: 512,
        ...(config.reasoning !== "off" ? { reasoning: config.reasoning } : {}),
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
    signal?.removeEventListener("abort", onParent);
  }
}
