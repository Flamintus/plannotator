/**
 * Skill references in comments — pure logic.
 *
 * A comment may reference agent skills by name with a `/` or `$` trigger
 * (interchangeable). References live in the comment TEXT itself (`$write-better`),
 * never as separate annotation state, so they survive draft restore, panel
 * edits, and share round-trips, and deleting the token deletes the reference.
 *
 * The catalog comes from `/api/skills` (see utils/skillCatalog.ts). This module
 * is browser-safe and dependency-free: trigger detection for the composer,
 * token extraction against a known catalog, and the export rendering hook the
 * feedback exporters call through a module-level registry seam
 * (`setSkillCatalogForExport`) whose default — an empty catalog — reproduces
 * pre-feature behavior byte-for-byte.
 */

import {
  extractSkillReferences,
  RESERVED_PATH_SEGMENTS,
  renderSkillReferencesBlock,
  slashTokenReadsAsProse,
  type SkillCatalogEntry,
  type SkillExportContent,
} from '@plannotator/core/skill-references';

// The pure rules live in core, so the Inbox's server composes the same block (packages/core/skill-references.ts).
export {
  extractSkillReferences,
  findSkillReferenceTokens,
  neutralizeSkillMarkerLines,
  renderSkillReferencesBlock,
  type SkillCatalogEntry,
  type SkillExportContent,
  type SkillReferencesBlockOptions,
  type SkillReferenceToken,
  type SkillRootId,
} from '@plannotator/core/skill-references';

export const SKILL_TRIGGER_CHARS = ['/', '$'] as const;
export type SkillTriggerChar = (typeof SKILL_TRIGGER_CHARS)[number];

/** Longest query the composer keeps treating as a skill lookup. */
export const MAX_SKILL_QUERY_LEN = 48;

/** Characters a skill name (and thus an in-progress query) may contain. */
const TOKEN_CHARS = /^[A-Za-z0-9._-]*$/;

export interface SkillTriggerContext {
  /** Index of the trigger character in the text. */
  start: number;
  trigger: SkillTriggerChar;
  /** Text between the trigger character and the caret. */
  query: string;
}

/**
 * The active skill trigger at `caret`, or null.
 *
 * A trigger is a `/` or `$` that starts a word: at position 0 or preceded by
 * whitespace or `(`. This is what keeps ordinary typing inert — `packages/ui`,
 * `and/or`, and `a/b` never trigger because their `/` follows a word character.
 * The query runs from the trigger to the caret and must stay within skill-name
 * characters, so typing a space (or any other breaking character) ends the
 * lookup naturally.
 *
 * A bare `/` or `$` (empty query) IS a trigger: it opens the full catalog,
 * matching how slash/skill menus behave in the host agents. The safety story
 * for a multi-line composer where Enter means newline and Tab means leave the
 * field lives in the MENU, not here: while the menu is open with NO row
 * explicitly activated (arrow keys), every key behaves exactly as if the menu
 * were closed — "This costs $" + Enter is a newline, "cd /" + Tab leaves the
 * field. See useSkillReferenceAutocomplete.
 */
export function findSkillTrigger(text: string, caret: number): SkillTriggerContext | null {
  if (caret < 1 || caret > text.length) return null;

  // Walk back over query characters to the nearest candidate trigger.
  let start = caret - 1;
  while (start >= 0 && !SKILL_TRIGGER_CHARS.includes(text[start] as SkillTriggerChar)) {
    if (caret - start > MAX_SKILL_QUERY_LEN) return null;
    start--;
  }
  if (start < 0) return null;

  const trigger = text[start] as SkillTriggerChar;
  const before = start === 0 ? '' : text[start - 1];
  if (before !== '' && !/[\s(]/.test(before)) return null;

  const query = text.slice(start + 1, caret);
  if (query.length > MAX_SKILL_QUERY_LEN) return null;
  if (!TOKEN_CHARS.test(query)) return null;

  return { start, trigger, query };
}

/**
 * Filter the catalog for the picker: case-insensitive, name prefix matches
 * first, then name substring, then description substring. Stable within each
 * tier (catalog order is alphabetical from the server).
 */
export function filterSkillCatalog(
  catalog: SkillCatalogEntry[],
  query: string,
  limit = 50,
): SkillCatalogEntry[] {
  const q = query.toLowerCase();
  if (!q) return catalog.slice(0, limit);

  const prefix: SkillCatalogEntry[] = [];
  const substring: SkillCatalogEntry[] = [];
  const description: SkillCatalogEntry[] = [];
  for (const entry of catalog) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(entry);
    else if (name.includes(q)) substring.push(entry);
    else if (entry.description?.toLowerCase().includes(q)) description.push(entry);
  }
  return [...prefix, ...substring, ...description].slice(0, limit);
}

/**
 * Replace the in-progress trigger token with the chosen skill (keeping the
 * trigger character the user typed) plus a trailing space, so the inserted
 * reference is always cleanly word-bounded. The exceptions to "keep the
 * typed trigger" all switch `/` to `$` because extraction would otherwise
 * drop the inserted reference:
 * - a skill whose name is a well-known absolute path segment (`run`, `tmp`…)
 *   — extraction reads `/run` as a path;
 * - a trigger immediately preceded by an HTTP verb or modal auxiliary
 *   ("could /simplify") — extraction reads that `/name` as prose (see
 *   SLASH_PROSE_PRECEDING_WORDS).
 */
export function insertSkillReference(
  text: string,
  caret: number,
  trigger: SkillTriggerContext,
  skill: SkillCatalogEntry,
): { text: string; caret: number } {
  const triggerChar =
    trigger.trigger === '/' &&
    (RESERVED_PATH_SEGMENTS.has(skill.name.toLowerCase()) ||
      slashTokenReadsAsProse(text, trigger.start))
      ? '$'
      : trigger.trigger;
  const inserted = `${triggerChar}${skill.name} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}

// ---------------------------------------------------------------------------
// Export seam
// ---------------------------------------------------------------------------

// Module-level registry seam (see packages/ui/CLAUDE.md): the exporters in
// utils/parser.ts are pure and cannot fetch, so the app registers the fetched
// catalog here once per session. Default (empty) means the exporters emit
// nothing extra — hosts without the endpoint are byte-for-byte unchanged.
let exportCatalog: SkillCatalogEntry[] = [];

export function setSkillCatalogForExport(catalog: SkillCatalogEntry[]): void {
  exportCatalog = catalog;
}

export function resetSkillCatalogForExport(): void {
  exportCatalog = [];
}

// Companion registry to the export catalog: bodies of the human-only skills
// the session has referenced, fetched lazily. Default (empty) means human-only
// references fall back to naming the skill plus its directory.
const exportContents = new Map<string, SkillExportContent>();

export function registerSkillContentForExport(name: string, content: SkillExportContent): void {
  exportContents.set(name, content);
}

export function resetSkillContentsForExport(): void {
  exportContents.clear();
}

/**
 * The export block for a comment's skill references, or '' when the comment
 * references none (or no catalog was registered). Appended to the comment in
 * the exported feedback so the acting agent knows which skills to apply.
 *
 * Model-invocable skills export as names — the agent can fetch those itself.
 * Human-only skills cannot be invoked by the agent, so their SKILL.md body is
 * injected verbatim (when the session fetched it): a human referencing a
 * human-only skill IS the human invocation. When no body is available the
 * skill falls back to its name plus its directory, and to the plain context
 * note when not even the directory is known. Never throws, never emits a
 * partial block.
 *
 * `injectedNames` is an optional per-export dedupe: exporters thread one Set
 * through every comment of a single export so a skill's instructions are
 * injected once, and later references point at the earlier injection.
 *
 * `options.external` marks a comment that was NOT written by the reviewer in
 * this UI — it arrived through the unauthenticated external-annotations API
 * (annotations carrying a `source`), which any local process can post to.
 * The whole justification for injection is that a human referencing a
 * human-only skill IS the human invocation, so a tool-submitted comment must
 * never cause it: external comments still LIST their skill references, but a
 * human-only reference falls back to naming the skill plus its directory
 * (the same shape as the content-unavailable path) instead of injecting.
 */
export function skillReferenceExportBlock(
  text: string | undefined,
  injectedNames?: Set<string>,
  options?: { external?: boolean },
): string {
  if (!text) return '';
  const refs = extractSkillReferences(text, exportCatalog);
  return renderSkillReferencesBlock(refs, {
    contentOf: (name) => exportContents.get(name),
    injectedNames,
    external: options?.external,
  });
}
