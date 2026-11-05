/**
 * A passage of a message's words that the reader selected, for a comment on
 * it (a sub-thread, as crit's): the words of one body only, a body being an
 * element that carries `data-passage-body="<message id>"`. A selection that
 * reaches past its body only by whitespace (a triple click, a drag past the
 * last line) is brought back to it; one that takes words outside it, or
 * spans two bodies, is no passage.
 *
 * The passage's offset counts the body's words as drawn, whitespace runs as
 * one (packages/core/passage.ts), so it holds however the words wrap; a body
 * drawn in pieces (boxes between its blocks) counts all its pieces' words.
 *
 * A comment on a passage is a comment like one on a document's words: the
 * selection toolbar offers the document's actions (`PassageToolbar`), and
 * each makes the same kind of annotation (`PassageComment`).
 */
import { findPassage, passageOffset, type TextPassage } from '@plannotator/core/passage';
import { AnnotationType, type Annotation } from '../types';
import { quickLabelText, THUMBS_UP_LABEL, type QuickLabel } from './quickLabels';

export const PASSAGE_BODY_ATTRIBUTE = 'data-passage-body';
/** On each piece of a body drawn in pieces (a message's words cut by the sub-threads' boxes between its blocks). */
export const PASSAGE_PIECE_ATTRIBUTE = 'data-passage-piece';

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

/**
 * A body's words and where `body` starts in them. A body drawn in pieces
 * (`PASSAGE_PIECE_ATTRIBUTE`, under one parent, in order) is its pieces' words
 * with one newline between two pieces, where blank lines were: an offset reads
 * any whitespace run as one, so the passage's offset is the one in the words.
 */
function bodyWords(body: HTMLElement, parentId: string): { words: string; at: number } {
  const parent = body.parentElement;
  if (!body.hasAttribute(PASSAGE_PIECE_ATTRIBUTE) || !parent) return { words: body.textContent ?? '', at: 0 };
  const pieces = Array.from(parent.children).filter((piece) => piece.hasAttribute(PASSAGE_PIECE_ATTRIBUTE) && piece.getAttribute(PASSAGE_BODY_ATTRIBUTE) === parentId);
  let words = '';
  let at = 0;
  pieces.forEach((piece, index) => {
    if (index > 0) words += '\n';
    if (piece === body) at = words.length;
    words += piece.textContent ?? '';
  });
  return { words, at };
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
  const { words, at } = bodyWords(body, parentId);
  const offset = passageOffset(words, at + before.toString().length + (raw.length - raw.trimStart().length));
  const box = typeof inside.getBoundingClientRect === 'function' ? inside.getBoundingClientRect() : body.getBoundingClientRect();
  return { parentId, quote, offset, rect: { top: box.top, left: box.left, width: box.width, height: box.height } };
}

/**
 * A comment on a passage as the selection toolbar makes it, the three ways a
 * document's words take one (useAnnotationHighlighter): Comment, the person's
 * words (no `type`); Delete, a deletion with no words (`DELETION_COMMENT`); a
 * quick label (👍 Looks good, the labels' picker), a comment whose words are
 * the label's (`quickLabelComment`).
 */
export interface PassageComment {
  text: string;
  mentions?: readonly string[];
  /** Absent: a comment. */
  type?: AnnotationType.COMMENT | AnnotationType.DELETION;
  isQuickLabel?: boolean;
  quickLabelTip?: string;
}

/** Delete on a passage: the person asks for the words to go, with no words of their own. */
export const DELETION_COMMENT: PassageComment = { text: '', type: AnnotationType.DELETION };

/** A quick label on a passage: a comment whose words are the label's emoji and text, with its tip, as on a document's words. */
export function quickLabelComment(label: QuickLabel): PassageComment {
  return { text: quickLabelText(label), type: AnnotationType.COMMENT, isQuickLabel: true, ...(label.tip ? { quickLabelTip: label.tip } : {}) };
}

/** The fields a passage comment gives its annotation beyond its words: its type and its label, as a document's comment carries them. */
export function passageCommentFields(comment: PassageComment): { type: AnnotationType.COMMENT | AnnotationType.DELETION } & Partial<Pick<Annotation, 'isQuickLabel' | 'quickLabelTip'>> {
  return {
    type: comment.type ?? AnnotationType.COMMENT,
    ...(comment.isQuickLabel ? { isQuickLabel: true } : {}),
    ...(comment.quickLabelTip ? { quickLabelTip: comment.quickLabelTip } : {}),
  };
}

/**
 * What kind of comment an annotation is, the toolbar's actions read back (`DELETION_COMMENT`, `quickLabelComment`,
 * Comment), at any depth and on any client: a deletion; 👍 Looks good, by its exact words (as other clients write it,
 * plannotator-tui's journal among them); another quick label, by its words; else a comment.
 */
export type CommentKind = { kind: 'comment' } | { kind: 'deletion' } | { kind: 'looks-good' } | { kind: 'label'; words: string };

export function commentKind(annotation: { type?: unknown; text?: unknown; isQuickLabel?: unknown }): CommentKind {
  if (annotation.type === AnnotationType.DELETION) return { kind: 'deletion' };
  const words = typeof annotation.text === 'string' ? annotation.text.trim() : '';
  if (words === quickLabelText(THUMBS_UP_LABEL)) return { kind: 'looks-good' };
  if (annotation.isQuickLabel === true && words !== '') return { kind: 'label', words };
  return { kind: 'comment' };
}

/** A passage a body marks; `deletion`: its comment asks for the words to go, marked as a document marks a deletion. */
export interface PassageMark extends TextPassage {
  deletion?: boolean;
}

/** A marked range of a body's words: start, end, and `true` third when every passage in it is a deletion. */
export type PassageRange = [number, number] | [number, number, true];

/**
 * The parts of `text` that the passages cover, in order and merged, as
 * index ranges of `text`: what a body marks. A passage whose words are no
 * longer there marks nothing. A range is a deletion's only when every
 * passage merged into it is one.
 */
export function passageRanges(text: string, passages: readonly PassageMark[]): PassageRange[] {
  const found = passages.flatMap((passage): PassageRange[] => {
    const range = findPassage(text, passage);
    return range === null ? [] : [passage.deletion ? [range[0], range[1], true] : [range[0], range[1]]];
  });
  found.sort((a, b) => a[0] - b[0]);
  const out: PassageRange[] = [];
  for (const range of found) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
      if (range.length === 2 && last.length === 3) out[out.length - 1] = [last[0], last[1]];
    } else out.push([...range] as PassageRange);
  }
  return out;
}

/** `text`, which starts at `base` in the body's words, cut into pieces that `ranges` mark (a deletion's, said so) and pieces they do not. */
export function splitByRanges(text: string, base: number, ranges: readonly PassageRange[]): { text: string; marked: boolean; deletion?: true }[] {
  const out: { text: string; marked: boolean; deletion?: true }[] = [];
  let at = 0;
  for (const range of ranges) {
    const from = Math.max(range[0] - base, at);
    const to = Math.min(range[1] - base, text.length);
    if (to <= from) continue;
    if (from > at) out.push({ text: text.slice(at, from), marked: false });
    out.push({ text: text.slice(from, to), marked: true, ...(range[2] ? { deletion: true as const } : {}) });
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
