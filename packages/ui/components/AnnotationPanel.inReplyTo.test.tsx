/**
 * Panel threading (DOM-gated): a reply renders indented directly under its
 * parent regardless of interleaving timestamps, a reply to a reply one level
 * deeper under that reply, an orphan reply renders as a top-level card, and
 * a list without replies renders no reply wrapper (the additive-field
 * guarantee).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./AnnotationPanel') : null;
const AnnotationPanel = panelModule?.AnnotationPanel as NonNullable<typeof panelModule>['AnnotationPanel'];

function ann(id: string, createdA: number, extra: Partial<Annotation> = {}): Annotation {
  return { id, blockId: 'blk-a', startOffset: 0, endOffset: 3, type: AnnotationType.COMMENT, text: `text ${id}`, originalText: 'abc', createdA, ...extra };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(annotations: Annotation[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AnnotationPanel isOpen annotations={annotations} blocks={[]} onSelect={() => {}} onDelete={() => {}} selectedId={null} />,
    );
  });
  return host;
}

const ids = (el: HTMLElement) => [...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'));
const depthOf = (el: HTMLElement, id: string) =>
  Number(el.querySelector(`[data-annotation-id="${id}"]`)!.closest('[data-annotation-reply]')?.getAttribute('data-annotation-depth') ?? 0);
/** The indent a reply's wrapper declares (one step per level). */
const indentOf = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`)!.closest<HTMLElement>('[data-annotation-reply]')!.style.paddingLeft;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe.skipIf(!hasDom)('AnnotationPanel inReplyTo threading', () => {
  test('a reply sits right under its parent, indented, even when another comment was created in between', async () => {
    const el = await render([ann('p', 1), ann('other', 2), ann('r', 3, { inReplyTo: 'p' })]);
    const ids = [...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'));
    expect(ids).toEqual(['p', 'r', 'other']);
    const reply = el.querySelector('[data-annotation-reply="true"]');
    expect(reply?.querySelector('[data-annotation-id="r"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-annotation-reply="true"]').length).toBe(1);
  });

  test("a reply to a reply sits under it, one level deeper, before the parent's later reply", async () => {
    // c answers a, written after b answered p: c belongs under a, not under b.
    const el = await render([ann('p', 1), ann('a', 2, { inReplyTo: 'p' }), ann('b', 3, { inReplyTo: 'p' }), ann('c', 4, { inReplyTo: 'a' })]);
    expect(ids(el)).toEqual(['p', 'a', 'c', 'b']);
    expect(['p', 'a', 'c', 'b'].map((id) => depthOf(el, id))).toEqual([0, 1, 2, 1]);
    expect(indentOf(el, 'a')).toBe(indentOf(el, 'b'));
    expect(indentOf(el, 'c')).not.toBe(indentOf(el, 'a'));
  });

  test('every level indents one more step, with no depth past which it stops, and one wrapper per card', async () => {
    // The user's rule for nested threads: the same indent at every level, no
    // rule by depth. A deep chain must still cost one wrapper per card.
    const chain = [ann('r0', 0)];
    for (let i = 1; i <= 12; i++) chain.push(ann(`r${i}`, i, { inReplyTo: `r${i - 1}` }));
    const el = await render(chain);
    expect(ids(el)).toEqual(chain.map((a) => a.id));
    const indents = chain.slice(1).map((a) => indentOf(el, a.id));
    expect(new Set(indents).size).toBe(12);
    expect(depthOf(el, 'r12')).toBe(12);
    for (const a of chain.slice(1)) {
      expect(el.querySelector(`[data-annotation-id="${a.id}"]`)!.parentElement!.hasAttribute('data-annotation-reply')).toBe(true);
    }
    expect(el.querySelectorAll('[data-annotation-reply] [data-annotation-reply]').length).toBe(0);
  });

  test("a reply does not repeat its parent's quote; a reply on its own words shows them", async () => {
    const el = await render([
      ann('p', 1, { originalText: 'the quoted words' }),
      ann('r', 2, { inReplyTo: 'p', originalText: 'the quoted words' }),
      ann('s', 3, { inReplyTo: 'p', originalText: 'other words' }),
    ]);
    const quoteOf = (id: string) => el.querySelector(`[data-annotation-id="${id}"]`)!.textContent!;
    expect(quoteOf('p')).toContain('"the quoted words"');
    expect(quoteOf('r')).not.toContain('the quoted words');
    expect(quoteOf('s')).toContain('"other words"');
  });

  test('an orphan reply renders as a top-level card', async () => {
    const el = await render([ann('a', 1), ann('r', 2, { inReplyTo: 'gone' })]);
    expect(el.querySelectorAll('[data-annotation-reply="true"]').length).toBe(0);
    expect([...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'))).toEqual(['a', 'r']);
  });

  test('an inReplyTo cycle renders every member as a top-level card, in order, and a reply to one still threads', async () => {
    const el = await render([ann('x', 1, { inReplyTo: 'y' }), ann('y', 2, { inReplyTo: 'x' }), ann('r', 3, { inReplyTo: 'x' })]);
    expect([...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'))).toEqual(['x', 'r', 'y']);
    const replies = el.querySelectorAll('[data-annotation-reply="true"]');
    expect(replies.length).toBe(1);
    expect(replies[0].querySelector('[data-annotation-id="r"]')).not.toBeNull();
  });

  test('without replies there is no reply wrapper and the order is creation order', async () => {
    const el = await render([ann('b', 2), ann('a', 1)]);
    expect(el.querySelectorAll('[data-annotation-reply="true"]').length).toBe(0);
    expect([...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'))).toEqual(['a', 'b']);
  });
});
