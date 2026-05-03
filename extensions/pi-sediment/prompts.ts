/**
 * pi-sediment prompts — per-target evaluator + writer.
 *
 * Pensieve: delegated to /skill:pensieve self-improve (no custom prompt needed).
 * gbrain:   dedicated evaluator + writer with timeline support.
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

ALL output MUST be in English — regardless of the source message language.

Read the FINAL assistant message of a coding-agent turn and decide whether
it contains a UNIVERSAL engineering principle worth saving to gbrain.

gbrain stores cross-project knowledge — patterns, anti-patterns, principles,
and pitfalls that apply beyond the current codebase. Do NOT store
project-specific details (file paths, module names, repo conventions).

Output ONLY a JSON block, nothing else:

{
  "decision": "skip" | "sediment",
  "summary": "one-sentence principle in English (empty if skip)"
}

CRITICAL: The summary field MUST be in English. Even if the source material
is in another language, you MUST output the summary in English.

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

CRITICAL — OUTPUT FORMAT (parseable, no deviation):

## GBRAIN
title: Present-Tense Imperative Headline (<= 100 chars)
tags: engineering, topic
__CONTENT__
# Title (same as headline above)

## Principle
One sentence.

## Guidance
- bullet 1
- bullet 2

## When this applies
- scenario

## Boundaries
- when NOT to apply

## Timeline
- **{date}** | pi-sediment — One-line summary

FORMAT RULES (NON-NEGOTIABLE):
1. The FIRST LINE of output MUST be exactly "## GBRAIN" (no code fences, no preamble)
2. The second line MUST be "title: ..."
3. The third line MUST be "tags: ..."
4. The fourth line MUST be "__CONTENT__"
5. After __CONTENT__, a blank line, then the markdown body
6. Do NOT wrap the output in \`\`\` code fences
7. ALL text MUST be in English

CONTENT RULES:
- Title must be in present-tense imperative form
- No file paths, module names, or project specifics anywhere
- Related pages are added to frontmatter automatically; mention related concepts by title when useful
- The Timeline section MUST include the provided date
- The Timeline section MUST be the FINAL section; put no prose after the timeline bullet
- Put all explanatory synthesis before ## Timeline, never after it
- Tags must include at least one specific topic tag beyond "engineering"
- Body must be >= 200 words of original synthesis`;

export function buildGbrainWritePrompt(args: {
  summary: string;
  dateIso: string;
  lastAssistantMessage: string;
  relatedPages: GbrainSearchResult[];
  formatError?: string;
}): string {
  let relatedSection = "";
  if (args.relatedPages.length > 0) {
    const lines = args.relatedPages.map(
      (p) => `- ${p.title} (${p.slug})`
    );
    relatedSection =
      "\n\nExisting related pages in gbrain (for conceptual context; links are added via frontmatter automatically):\n" +
      lines.join("\n");
  }

  let formatErrorSection = "";
  if (args.formatError) {
    formatErrorSection =
      `\n\n⚠️  PREVIOUS ATTEMPT FAILED — FORMAT ERROR:\n${args.formatError}\n\nCRITICAL: Fix the format error above. Follow the output format EXACTLY as specified.`;
  }

  return `Insight summary: ${args.summary}

Date: ${args.dateIso}

Source material (full assistant message):

<source>
${args.lastAssistantMessage}
</source>${relatedSection}${formatErrorSection}

Produce the gbrain entry using the markdown section format above.`;
}
