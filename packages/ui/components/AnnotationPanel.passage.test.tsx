/**
 * A comment on a passage of a card's words (`onCommentPassage`, a
 * sub-thread; DOM-gated):
 *  - a host without the seam gets nothing: no body attribute, no toolbar;
 *  - words selected in one card's text offer the selection toolbar, and its
 *    Comment, or a letter typed, opens the panel's box under that card, the
 *    passage at its head; saving sends the parent, the passage with its
 *    offset in the words as drawn, and the comment, without selecting the
 *    card; a save the host refused keeps the box and its words;
 *  - no offer for words across two cards, or on a card the host turned off;
 *  - the passages the host names are marked in the card's words.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./AnnotationPanel') : null;
const AnnotationPanel = panelModule?.AnnotationPanel as NonNullable<typeof panelModule>['AnnotationPanel'];
type PanelProps = React.ComponentProps<typeof AnnotationPanel>;

const STEPS = 'Step 1 tags it.\nStep 2 rolls back through the off switch.';

function ann(id: string, createdA: number, extra: Partial<Annotation> = {}): Annotation {
  return { id, blockId: 'blk-a', startOffset: 0, endOffset: 3, type: AnnotationType.COMMENT, text: `text ${id}`, originalText: 'abc', createdA, ...extra };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(props: Partial<PanelProps>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<AnnotationPanel isOpen annotations={[]} blocks={[]} onSelect={() => {}} onDelete={() => {}} selectedId={null} {...props} />);
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const words = (id: string) => document.querySelector<HTMLElement>(`[data-annotation-id="${id}"] p.whitespace-pre-wrap:not(.font-mono)`)!;
const toolbar = () => document.querySelector('[data-pn-annotation-toolbar-row]');
const box = () => document.querySelector<HTMLElement>('[data-annotation-passage-composer]');

/** Select `quote` in a card's words (or from one card's words to another's) and let the mouse go. */
async function select(id: string, quote: string, endId = id, endQuote = quote) {
  const start = words(id).firstChild as Text;
  const end = words(endId).firstChild as Text;
  const range = document.createRange();
  range.setStart(start, start.data.indexOf(quote));
  range.setEnd(end, end.data.indexOf(endQuote) + endQuote.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    words(endId).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe.skipIf(!hasDom)('AnnotationPanel comment on a passage', () => {
  test('without the seam a card is as before: no body attribute and no toolbar', async () => {
    await render({ annotations: [ann('p', 1, { text: STEPS })] });
    expect(document.querySelector('[data-passage-body]')).toBeNull();
    await select('p', 'off switch');
    expect(toolbar()).toBeNull();
  });

  test("Comment opens the box under the card's replies with the passage; saving sends it, offset as drawn, without selecting the card", async () => {
    const sent: unknown[] = [];
    const selected: string[] = [];
    await render({
      annotations: [ann('p', 1, { text: STEPS }), ann('r', 2, { inReplyTo: 'p' }), ann('q', 3)],
      onSelect: (id) => selected.push(id),
      onCommentPassage: (parentId, passage, comment) => {
        sent.push([parentId, passage, comment]);
      },
    });
    await select('p', 'off switch');
    expect(toolbar()).not.toBeNull();
    // The press that ended the selection is no click on the card.
    await act(async () => { words('p').click(); });
    expect(selected).toEqual([]);

    await act(async () => { document.querySelector<HTMLButtonElement>('button[title="Comment"]')!.click(); });
    expect(toolbar()).toBeNull();
    expect(box()!.textContent).toContain('"off switch"');
    // Where the comment will land: after p's reply, one level under p.
    const order = [...document.querySelectorAll('[data-annotation-id], [data-annotation-reply-composer]')].map((n) => n.getAttribute('data-annotation-id') ?? 'BOX');
    expect(order).toEqual(['p', 'r', 'BOX', 'q']);
    expect(box()!.closest('[data-annotation-reply-composer]')!.getAttribute('data-annotation-depth')).toBe('1');

    const field = box()!.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(field, '  Which off switch?  ');
    await act(async () => { [...box()!.querySelectorAll('button')].find((b) => b.textContent === 'Comment')!.click(); });
    // The offset counts the words as drawn, whitespace runs as one (the newline after "it." is one).
    expect(sent).toEqual([['p', { quote: 'off switch', offset: 'Step 1 tags it. Step 2 rolls back through the '.length }, { text: 'Which off switch?' }]]);
    expect(box()).toBeNull();
    expect(selected).toEqual([]);
  });

  test('a letter typed over the toolbar starts the comment with it; a refused save keeps the box and its words', async () => {
    await render({ annotations: [ann('p', 1, { text: STEPS })], onCommentPassage: () => false });
    await select('p', 'rolls back');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', bubbles: true, cancelable: true })); });
    const field = box()!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(field.value).toBe('W');
    await type(field, 'Why back?');
    await act(async () => { [...box()!.querySelectorAll('button')].find((b) => b.textContent === 'Comment')!.click(); });
    expect(box()!.querySelector('textarea')!.value).toBe('Why back?');
  });

  test("no offer for words across two cards, nor on a card the host turned off", async () => {
    await render({
      annotations: [ann('p', 1, { text: STEPS }), ann('q', 2, { text: 'Other words here.' })],
      onCommentPassage: () => {},
      cardParts: (a) => (a.id === 'q' ? { passage: false } : {}),
    });
    await select('p', 'off switch', 'q', 'Other');
    expect(toolbar()).toBeNull();
    expect(document.querySelector('[data-annotation-id="q"] [data-passage-body]')).toBeNull();
    await select('q', 'words');
    expect(toolbar()).toBeNull();
  });

  test("the host's passages are marked in the card's words, found again by their words", async () => {
    await render({
      annotations: [ann('p', 1, { text: STEPS })],
      onCommentPassage: () => {},
      cardPassages: (a) => (a.id === 'p' ? [{ quote: 'off  switch', offset: 40 }, { quote: 'not there', offset: 0 }] : []),
    });
    expect([...document.querySelectorAll('[data-annotation-id="p"] mark[data-passage-mark]')].map((m) => m.textContent)).toEqual(['off switch']);
    expect(words('p').textContent).toBe(STEPS);
  });
});
