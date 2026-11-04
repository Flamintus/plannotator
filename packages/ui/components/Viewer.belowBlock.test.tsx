/**
 * `Viewer` `belowBlock`: a host's node drawn right under one block (the Inbox
 * draws a comment thread under the block its passage is in), driven through
 * the REAL Viewer and web-highlighter (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: the prop, or a block it has nothing for, leaks DOM; a
 * slot lands somewhere other than right after its block (a list item's
 * inside its list, right after the item); a slot that comes later remounts
 * its block and drops the highlight painted there; the slots' own elements
 * renumber web-highlighter's positional metas, so a comment made, or
 * restored, with slots above it lands on the WRONG one of two identical
 * paragraphs; a selection inside a slot becomes a comment.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation, type Block, type EditorMode } from '../types';

const hasDom = typeof document !== 'undefined';
// web-highlighter's UMD bundle reads `window` at module eval; import lazily.
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const DOC = [
  'Roll out on Monday.',
  '',
  '- Tag the release.',
  '- Watch the error rate.',
  '',
  'Ship the same build twice.',
  '',
  'Ship the same build twice.',
].join('\n');

/** A thread as a host draws it: `<p>`, `<span>` and a button, the tags a comment's parent element usually has. */
const thread = (label: string) => (
  <div data-testid={`thread-${label}`}>
    <p><span>“{label}”</span> Round 1</p>
    <p>Ship the same build twice.</p>
    <button type="button">Reply</button>
  </div>
);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

interface Handle { applySharedAnnotations: (annotations: Annotation[]) => void }

const blocks = () => parserModule!.parseMarkdownToBlocks(DOC);
const blockWith = (text: string) => blocks().find((block) => block.content.includes(text))!.id;

function element(options: { belowBlock?: (block: Block) => React.ReactNode; mode?: EditorMode; onAddAnnotation?: (annotation: Annotation) => void; ref?: React.RefObject<Handle | null> }) {
  const Viewer = viewerModule!.Viewer;
  return (
    <Viewer
      ref={options.ref as never}
      blocks={blocks()}
      markdown={DOC}
      annotations={[]}
      onAddAnnotation={options.onAddAnnotation ?? (() => {})}
      onSelectAnnotation={() => {}}
      selectedAnnotationId={null}
      mode={options.mode ?? 'selection'}
      taterMode={false}
      stickyActions={false}
      disableCodePathValidation
      {...(options.belowBlock ? { belowBlock: options.belowBlock } : {})}
    />
  );
}

async function mount(options: Parameters<typeof element>[0] = {}): Promise<{ article: HTMLElement; ref: React.RefObject<Handle | null> }> {
  const ref = options.ref ?? React.createRef<Handle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(element({ ...options, ref }));
  });
  await settle();
  const article = host.querySelector<HTMLElement>('article[data-print-region="article"]');
  if (!article) throw new Error('Viewer did not render its annotation container');
  return { article, ref };
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  window.getSelection()?.removeAllRanges();
}

/** Select `phrase` in the `nth` text node holding it and release the pointer. */
async function select(scope: HTMLElement, phrase: string, nth = 0) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) hits.push(n as Text);
  const node = hits[nth]!;
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const shipParagraphs = (article: HTMLElement) => [...article.querySelectorAll<HTMLElement>('p[data-block-id]')].filter((p) => p.textContent === 'Ship the same build twice.');

/** A thread under the first paragraph and under the list's first item: above both identical paragraphs. */
const above = (block: Block) => (block.id === blockWith('Roll out') ? thread('Monday') : block.id === blockWith('Tag the release') ? thread('Tag') : null);

describe('Viewer belowBlock: where it renders', () => {
  test.skipIf(!hasDom)('absent, or nothing for any block: the same DOM as without the prop', async () => {
    const without = (await mount()).article.outerHTML;
    await unmount();
    for (const value of [null, undefined, false, true]) {
      const { article } = await mount({ belowBlock: () => value });
      expect(article.outerHTML).toBe(without);
      expect(article.querySelector('[data-viewer-below-block]')).toBeNull();
      await unmount();
    }
  });

  test.skipIf(!hasDom)("right after its block; a list item's inside its list, right after the item; outside everything that addresses the text", async () => {
    const { article } = await mount({ belowBlock: above });
    const slots = [...article.querySelectorAll<HTMLElement>('[data-viewer-below-block]')];
    expect(slots.map((slot) => slot.dataset.belowBlock)).toEqual([blockWith('Roll out'), blockWith('Tag the release')]);
    const [first, item] = slots as [HTMLElement, HTMLElement];
    expect((first.previousElementSibling as HTMLElement).textContent).toBe('Roll out on Monday.');
    expect(first.parentElement).toBe(article);
    expect((item.previousElementSibling as HTMLElement).dataset.blockId).toBe(blockWith('Tag the release'));
    expect((item.nextElementSibling as HTMLElement).textContent).toContain('Watch the error rate.');
    expect(item.parentElement!.hasAttribute('data-pinpoint-group')).toBe(true);
    for (const slot of slots) {
      expect(slot.classList.contains('annotation-exclude')).toBe(true);
      expect(slot.hasAttribute('data-pinpoint-ignore')).toBe(true);
      expect(slot.hasAttribute('data-print-hide')).toBe(true);
      expect(slot.hasAttribute('data-block-id')).toBe(false);
    }
  });

  test.skipIf(!hasDom)('a slot that comes after the highlights were painted keeps its block and the highlight on it', async () => {
    const ref = React.createRef<Handle>();
    const { article } = await mount({ ref });
    await act(async () => {
      ref.current!.applySharedAnnotations([
        { id: 'annMonday', blockId: blockWith('Roll out'), startOffset: 12, endOffset: 18, type: AnnotationType.COMMENT, text: 'why?', originalText: 'Monday', createdA: 1 },
      ]);
    });
    const block = article.querySelector<HTMLElement>(`[data-block-id="${blockWith('Roll out')}"]`)!;
    expect(block.querySelector('[data-bind-id="annMonday"], [data-highlight-id="annMonday"]')).not.toBeNull();
    await act(async () => { root!.render(element({ ref, belowBlock: above })); });
    await settle();
    expect(article.querySelector('[data-viewer-below-block]')).not.toBeNull();
    // The very same element, its highlight still painted.
    expect(article.querySelector(`[data-block-id="${blockWith('Roll out')}"]`)).toBe(block);
    expect(block.querySelector('[data-bind-id="annMonday"], [data-highlight-id="annMonday"]')).not.toBeNull();
  });
});

describe('Viewer belowBlock: comment positions ignore the slots', () => {
  test.skipIf(!hasDom)('a comment on the second of two identical paragraphs stores the same metas with slots above it as without', async () => {
    const made: Annotation[] = [];
    await mount({ mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    await select(host!, 'same build', 1);
    await unmount();
    const slotted = await mount({ belowBlock: above, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    // The slots' own "Ship the same build twice." come first: the document's second paragraph is the 4th hit.
    await select(slotted.article, 'same build', 3);
    expect(made).toHaveLength(2);
    const [without, withSlots] = made;
    expect(withSlots!.originalText).toBe('same build');
    expect(withSlots!.startMeta).toEqual(without!.startMeta);
    expect(withSlots!.endMeta).toEqual(without!.endMeta);
  });

  test.skipIf(!hasDom)('a stored comment on the second of two identical paragraphs restores onto that paragraph with slots above it', async () => {
    const plain = await mount();
    const index = ([...plain.article.getElementsByTagName('p')] as HTMLElement[]).indexOf(shipParagraphs(plain.article)[1]!);
    await unmount();
    const stored: Annotation = {
      id: 'annSecond',
      blockId: 'any',
      startOffset: 9,
      endOffset: 19,
      type: AnnotationType.COMMENT,
      text: 'which build?',
      originalText: 'same build',
      createdA: 1,
      startMeta: { parentTagName: 'P', parentIndex: index, textOffset: 9 },
      endMeta: { parentTagName: 'P', parentIndex: index, textOffset: 19 },
    };
    const { article, ref } = await mount({ belowBlock: above });
    await act(async () => { ref.current!.applySharedAnnotations([stored]); });
    const marks = [...article.querySelectorAll<HTMLElement>('[data-highlight-id="annSecond"], [data-bind-id="annSecond"]')];
    expect(marks.map((m) => m.textContent).join('')).toBe('same build');
    expect(marks.every((m) => shipParagraphs(article)[1]!.contains(m))).toBe(true);
    expect(article.querySelector('[data-viewer-below-block] mark')).toBeNull();
  });

  test.skipIf(!hasDom)('a selection inside a slot makes no comment and opens no toolbar', async () => {
    const made: Annotation[] = [];
    const redline = await mount({ belowBlock: above, mode: 'redline', onAddAnnotation: (a) => made.push(a) });
    await select(redline.article.querySelector('[data-viewer-below-block]')!, 'Round 1');
    expect(made).toEqual([]);
    expect(redline.article.querySelector('[data-viewer-below-block] mark')).toBeNull();
    await unmount();

    const selection = await mount({ belowBlock: above, mode: 'selection' });
    await select(selection.article.querySelectorAll<HTMLElement>('[data-viewer-below-block]')[1]!, 'Round 1');
    expect(document.querySelector('.annotation-toolbar')).toBeNull();
  });
});
