/**
 * pi-sediment prompts — per-target evaluator + writer.
 *
 * Pensieve: delegated to /skill:pensieve self-improve (no custom prompt needed).
 * gbrain:   dedicated evaluator + writer with wikilinks and timeline support.
 */

import type { GbrainSearchResult } from "./types.js";

// ── Injection filter patterns (from gstack) ─────────────────────

export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+/i,
  /always\s+output\s+no\s+findings/i,
  /skip\s+(all\s+)?(security|review|checks)/i,
  /override[:\s]/i,
  /\bsystem\s*:/i,
  /\bassistant\s*:/i,
  /\buser\s*:/i,
  /do\s+not\s+(report|flag|mention)/i,
  /approve\s+(all|every|this)/i,
];

/**
 * Sanitize LLM-generated content against prompt injection patterns.
 * Returns null if a pattern matches (content rejected).
 */
export function sanitizeContent(content: string): string | null {
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(content)) return null;
  }
  return content;
}

// ── gbrain evaluator ────────────────────────────────────────────

export const GBRAIN_EVAL_PROMPT = `You are the pi-sediment gbrain evaluator.

Read the FINAL assistant message of a coding-agent turn and decide whether
it contains a UNIVERSAL engineering principle worth saving to gbrain.

gbrain stores cross-project knowledge — patterns, anti-patterns, principles,
and pitfalls that apply beyond the current codebase. Do NOT store
project-specific details (file paths, module names, repo conventions).

Output ONLY a JSON block, nothing else:

{
  "decision": "skip" | "sediment",
  "summary": "one-sentence principle (empty if skip)"
}

Sediment when:
- A bug root cause reveals a pattern others would hit
- An architectural tradeoff settles a general design question
- A non-obvious pitfall or anti-pattern is discovered
- An API/library behavior is documented with a workaround
- A cross-cutting engineering principle is articulated

Skip when:
- The insight is project-specific (file paths, internal module names)
- The turn is routine execution (formatting, renaming, dependency bumps)
- The content is obvious or already well-known
- Status updates, user questions, or exploration without conclusion

Be conservative. False positives pollute memory. When in doubt, skip.`;

export function buildGbrainEvalPrompt(args: {
  lastAssistantMessage: string;
  gbrainColdStart: boolean;
}): string {
  let extra = "";
  if (args.gbrainColdStart) {
    extra =
      "\n\nNOTE: Your gbrain knowledge base is nearly empty (< 10 pages). " +
      "If you discover ANY insight with cross-project engineering value, " +
      "lean toward sediment.";
  }
  return `Evaluate this assistant message and emit the JSON decision.${extra}

<assistant-message>
${args.lastAssistantMessage}
</assistant-message>`;
}

// ── gbrain writer ───────────────────────────────────────────────

export const GBRAIN_WRITE_PROMPT = `You are the pi-sediment gbrain writer.

Given an engineering insight, produce a gbrain page: a universal principle
distilled from the source material. The output must be self-contained and
readable without referencing the original conversation.

Output format:

## GBRAIN
title: <= 100 char headline (present-tense imperative, e.g. "Verify Connectivity By Performing A Real Operation")
tags: engineering, relevant-topic-1, relevant-topic-2
__CONTENT__
Full markdown body with these sections:

# Title

## Principle
One sentence stating the principle.

## Guidance
- 3-5 actionable guidelines

## When this applies
- Scenarios where this principle helps

## Boundaries
- When NOT to apply this (important — prevents overgeneralization)

## Timeline
- **{date}** | pi-sediment — One-line summary of when this insight was captured

RULES:
- Title must be in present-tense imperative form
- Content must contain NO file paths, NO module names, NO project specifics
- When referencing related engineering principles that exist as brain pages,
  use [[exact-slug]] wikilink syntax (see the list of related pages provided
  in the prompt for available slugs)
- The Timeline section MUST be included with the date provided
- Tags must include at least one specific topic tag beyond "engineering"
- Body must be >= 200 words of original synthesis, not a copy-paste`;

export function buildGbrainWritePrompt(args: {
  summary: string;
  dateIso: string;
  lastAssistantMessage: string;
  relatedPages: GbrainSearchResult[];
}): string {
  let relatedSection = "";
  if (args.relatedPages.length > 0) {
    const lines = args.relatedPages.map(
      (p) => `- [[${p.slug}]]: ${p.title}`
    );
    relatedSection =
      "\n\nExisting related pages in gbrain (use these slugs when adding [[wikilink]] references):\n" +
      lines.join("\n");
  }

  return `Insight summary: ${args.summary}

Date: ${args.dateIso}

Source material (full assistant message):

<source>
${args.lastAssistantMessage}
</source>${relatedSection}

Produce the gbrain entry using the markdown section format above.`;
}
