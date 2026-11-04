/**
 * The person's Reply on a plan-annotation card (DOM-gated):
 *  - a host without `onReply` gets no Reply action and no box (unchanged);
 *  - Reply opens one box where the reply will land (after the card's own
 *    replies, one level under it) and sends to THAT card, without selecting it;
 *  - Escape and Cancel send nothing, and an empty box cannot send;
 *  - a reply the host could not save (`false`) keeps the box and its words;
 *  - the words of a box whose card is gone do not come back under another;
 *  - no Reply under `readOnly`, on a card whose place is not a text highlight
 *    (a region of an image, a checkbox toggle, a question's answer), or on
 *    another document's cards in the All files view.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./AnnotationPanel') : null;
const AnnotationPanel = panelModule?.AnnotationPanel as NonNullable<typeof panelModule>['AnnotationPanel'];
type PanelProps = React.ComponentProps<typeof AnnotationPanel>;

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
});

const replyButton = (id: string) => document.querySelector<HTMLButtonElement>(`[data-annotation-id="${id}"] button[title="Reply"]`);
const replyField = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]');
const buttonNamed = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
}

/** Card ids and the reply box, in the order they are drawn. */
function drawnOrder(): string[] {
  return [...document.querySelectorAll('[data-annotation-id], [data-annotation-reply-composer]')]
    .map((n) => n.getAttribute('data-annotation-id') ?? 'BOX');
}

describe.skipIf(!hasDom)('AnnotationPanel Reply', () => {
  test('without onReply there is no Reply action and no box', async () => {
    await render({ annotations: [ann('p', 1), ann('r', 2, { inReplyTo: 'p' })] });
    expect(document.querySelector('button[title="Reply"]')).toBeNull();
    expect(document.querySelector('[data-annotation-reply-composer]')).toBeNull();
  });

  test("Reply on a reply opens the box after that reply's own replies, one level deeper, and sends to it", async () => {
    const sent: Array<[string, { text: string; mentions?: readonly string[] }]> = [];
    const selected: string[] = [];
    // a answers p and c answers a; b is p's later reply.
    await render({
      annotations: [ann('p', 1), ann('a', 2, { inReplyTo: 'p' }), ann('c', 3, { inReplyTo: 'a' }), ann('b', 4, { inReplyTo: 'p' })],
      onReply: (parentId, reply) => { sent.push([parentId, reply]); },
      onSelect: (id) => { selected.push(id); },
    });
    await act(async () => { replyButton('a')!.click(); });

    expect(selected).toEqual([]);
    expect(drawnOrder()).toEqual(['p', 'a', 'c', 'BOX', 'b']);
    // The box sits at c's depth: where a's next reply lands.
    const box = document.querySelector('[data-annotation-reply-composer]')!;
    expect(box.getAttribute('data-annotation-depth')).toBe('2');
    expect((box as HTMLElement).style.paddingLeft).toBe(
      document.querySelector('[data-annotation-id="c"]')!.closest<HTMLElement>('[data-annotation-reply]')!.style.paddingLeft,
    );
    expect(document.activeElement).toBe(replyField());

    await type(replyField()!, '  Agreed, the second option.  ');
    await press(replyField()!, 'Enter', { metaKey: true });

    expect(sent).toEqual([['a', { text: 'Agreed, the second option.' }]]);
    expect(replyField()).toBeNull();
  });

  test('Escape and Cancel send nothing, and an empty box cannot send', async () => {
    const sent: string[] = [];
    await render({ annotations: [ann('p', 1)], onReply: (parentId) => { sent.push(parentId); } });

    await act(async () => { replyButton('p')!.click(); });
    expect(buttonNamed('Reply')!.hasAttribute('disabled')).toBe(true);
    await press(replyField()!, 'Enter', { metaKey: true });
    await type(replyField()!, 'never mind');
    await press(replyField()!, 'Escape');
    expect(replyField()).toBeNull();

    await act(async () => { replyButton('p')!.click(); });
    await type(replyField()!, 'never mind either');
    await act(async () => { buttonNamed('Cancel')!.click(); });
    expect(replyField()).toBeNull();
    expect(sent).toEqual([]);
  });

  test('a reply the host could not save keeps the box open with its words; one it saved closes it', async () => {
    let saved = false;
    await render({ annotations: [ann('p', 1)], onReply: async () => saved });
    await act(async () => { replyButton('p')!.click(); });
    await type(replyField()!, 'Tuesday then');
    await press(replyField()!, 'Enter', { metaKey: true });
    expect(replyField()!.value).toBe('Tuesday then');
    saved = true;
    await press(replyField()!, 'Enter', { metaKey: true });
    expect(replyField()).toBeNull();
  });

  test("a box whose card is gone takes its words with it", async () => {
    const props: Partial<PanelProps> = { onReply: () => {} };
    await render({ ...props, annotations: [ann('p', 1), ann('q', 2)] });
    await act(async () => { replyButton('p')!.click(); });
    await type(replyField()!, 'about p');
    await act(async () => { root!.render(<AnnotationPanel isOpen blocks={[]} onSelect={() => {}} onDelete={() => {}} selectedId={null} {...props} annotations={[ann('q', 2)]} />); });
    expect(replyField()).toBeNull();
    await act(async () => { replyButton('q')!.click(); });
    expect(replyField()!.value).toBe('');
  });

  test('a second Reply on the same card puts the caret back in its box', async () => {
    await render({ annotations: [ann('p', 1)], onReply: () => {} });
    await act(async () => { replyButton('p')!.click(); });
    await type(replyField()!, 'half');
    await act(async () => { replyField()!.blur(); });
    expect(document.activeElement).not.toBe(replyField());
    await act(async () => { replyButton('p')!.click(); });
    expect(document.activeElement).toBe(replyField());
    expect(replyField()!.value).toBe('half');
  });

  test('no Reply under readOnly, nor on a card whose place is not a text highlight', async () => {
    const region = ann('img', 2, {
      originalText: 'shot.png',
      imageRegion: { v: 1, src: 'shot.png', sourceLine: 3, box: { x: 1, y: 1, w: 10, h: 10 }, naturalWidth: 100, naturalHeight: 100 },
    });
    const checkbox = ann('ann-checkbox-block-2', 3, { originalText: '- [ ] Ship it' });
    const answer = ann('ann-question-ship', 4, {
      originalText: 'Ship now?',
      questionAnswer: { v: 1, key: 'ship', kind: 'single', prompt: 'Ship now?', selected: ['Yes'] },
    });
    await render({ annotations: [ann('p', 1), region, checkbox, answer], onReply: () => {} });
    expect(replyButton('p')).not.toBeNull();
    expect(replyButton('img')).toBeNull();
    expect(replyButton('ann-checkbox-block-2')).toBeNull();
    expect(replyButton('ann-question-ship')).toBeNull();
    await act(async () => { root!.unmount(); });
    host!.remove();
    root = null;

    await render({ annotations: [ann('p', 1)], onReply: () => {}, readOnly: true });
    expect(replyButton('p')).toBeNull();
  });

  test("All files: Reply on the open document's cards only", async () => {
    const open = ann('here', 1);
    const elsewhere = ann('there', 2);
    await render({
      annotations: [open],
      onReply: () => {},
      annotationScope: 'all',
      onAnnotationScopeChange: () => {},
      documentGroups: [
        { path: '/doc/a.md', label: 'a.md', isCurrent: true, annotations: [open] },
        { path: '/doc/b.md', label: 'b.md', isCurrent: false, annotations: [elsewhere] },
      ],
    });
    expect(replyButton('here')).not.toBeNull();
    expect(replyButton('there')).toBeNull();
  });
});
