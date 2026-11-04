/**
 * AnnotationPanel `cardParts` `actions: false` (DOM-gated): the Inbox's
 * comments already sent are drawn without edit or delete.
 *
 * Failures to catch: a card the host marked still offering Edit or Delete
 * (the store refuses both once a comment is sent), the other cards losing
 * theirs, and the host's header slot (where the Inbox draws the round)
 * disappearing with the actions.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

function row(id: string): Annotation {
  return { id, blockId: 'b1', startOffset: 0, endOffset: 5, type: AnnotationType.COMMENT, text: `note ${id}`, originalText: 'hello', createdA: Number(id.replace(/\D/g, '')) || 1 };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

describe.if(hasDom)('AnnotationPanel cardParts actions', () => {
  test('a card drawn with actions: false has no Edit or Delete; the others keep theirs, and its header slot stays', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <AnnotationPanel
          isOpen
          annotations={[row('d1'), row('s2')]}
          blocks={[]}
          onSelect={() => {}}
          onDelete={() => {}}
          onEdit={() => {}}
          selectedId={null}
          cardParts={(annotation) => (annotation.id === 's2' ? { actions: false } : {})}
          renderCardHeader={(annotation) => (annotation.id === 's2' ? <span data-stamp="">Round 1</span> : null)}
        />,
      );
    });
    const card = (id: string) => host!.querySelector(`[data-annotation-id="${id}"]`)!;
    const buttons = (id: string) => card(id).querySelectorAll('button').length;
    expect(buttons('d1')).toBeGreaterThanOrEqual(2);
    expect(buttons('s2')).toBe(0);
    expect(card('s2').querySelector('[data-stamp]')).not.toBeNull();
  });
});
