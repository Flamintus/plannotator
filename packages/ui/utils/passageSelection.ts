/**
 * A passage of a message's words that the reader selected, for a comment on
 * it (a sub-thread, as crit's): the words of one body only, a body being an
 * element that carries `data-passage-body="<message id>"`. A selection that
 * reaches past its body only by whitespace (a triple click, a drag past the
 * last line) is brought back to it; one that takes words outside it, or
 * spans two bodies, is no passage.
 *
 * The passage's offset counts the body's words as drawn, whitespace runs as
 * one (packages/core/passage.ts), so it holds however the words wrap.
 */
import { findPassage, passageOffset, type TextPassage } from '@plannotator/core/passage';

export const PASSAGE_BODY_ATTRIBUTE = 'data-passage-body';

export interface SelectedPassage extends TextPassage {
  /** The message the passage is in: its body's `data-passage-body`. */
  parentId: string;
  /** Where the selection is on screen, for the toolbar. */
  rect: { top: number; left: number; width: number; height: number };
}

function bodyOf(node: Node | null, within: Element): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  const body = element?.closest<HTMLElement>(`[${PASSAGE_BODY_ATTRIBUTE}]`) ?? null;
  return body && within.contains(body) ? body : null;
}

/** The passage the document's selection holds inside `within`, or null. */
export function selectedPassage(within: Element, selection: Selection | null = within.ownerDocument.getSelection()): SelectedPassage | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const body = bodyOf(range.startContainer, within) ?? bodyOf(range.endContainer, within);
  if (!body) return null;
  const parentId = body.getAttribute(PASSAGE_BODY_ATTRIBUTE);
  if (!parentId) return null;
  // The part of the selection inside the body; anything else must be whitespace.
  const inside = range.cloneRange();
  const doc = body.ownerDocument;
  const whole = doc.createRange();
  whole.selectNodeContents(body);
  if (inside.compareBoundaryPoints(Range.START_TO_START, whole) < 0) inside.setStart(whole.startContainer, whole.startOffset);
  if (inside.compareBoundaryPoints(Range.END_TO_END, whole) > 0) inside.setEnd(whole.endContainer, whole.endOffset);
  const raw = inside.toString();
  const quote = raw.trim();
  if (quote === '' || range.toString().trim() !== quote) return null;
  const before = doc.createRange();
  before.setStart(whole.startContainer, whole.startOffset);
  before.setEnd(inside.startContainer, inside.startOffset);
  const words = body.textContent ?? '';
  const offset = passageOffset(words, before.toString().length + (raw.length - raw.trimStart().length));
  const box = typeof inside.getBoundingClientRect === 'function' ? inside.getBoundingClientRect() : body.getBoundingClientRect();
  return { parentId, quote, offset, rect: { top: box.top, left: box.left, width: box.width, height: box.height } };
}

/**
 * The parts of `text` that the passages cover, in order and merged, as
 * index ranges of `text`: what a body marks. A passage whose words are no
 * longer there marks nothing.
 */
export function passageRanges(text: string, passages: readonly TextPassage[]): [number, number][] {
  const found = passages.map((passage) => findPassage(text, passage)).filter((range): range is [number, number] => range !== null);
  found.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of found) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** `text`, which starts at `base` in the body's words, cut into pieces that `ranges` mark and pieces they do not. */
export function splitByRanges(text: string, base: number, ranges: readonly [number, number][]): { text: string; marked: boolean }[] {
  const out: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(start - base, at);
    const to = Math.min(end - base, text.length);
    if (to <= from) continue;
    if (from > at) out.push({ text: text.slice(at, from), marked: false });
    out.push({ text: text.slice(from, to), marked: true });
    at = to;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out;
}

/** Whether the document's selection holds words inside `element` (a press that ends a selection there is no click). */
export function selectionWithin(element: Element): boolean {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  return element.contains(range.startContainer) || element.contains(range.endContainer);
}
