/**
 * Which page a live app annotation is stamped with as it is added. A reply
 * stamped with the page open when it was written instead of its parent's
 * would be restored on the wrong page, marked Unanchored there, and shown
 * with a page chip that contradicts its parent's.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { stampLivePage } from './livePageStamp';

const comment = (extra: Partial<Annotation> = {}): Annotation => ({
  id: 'c', blockId: '', startOffset: 0, endOffset: 0, type: AnnotationType.COMMENT, text: 't', originalText: 'Pay now', createdA: 1, ...extra,
});

describe('stampLivePage', () => {
  test('a comment takes the page open now; a global comment, or no page yet, stamps nothing', () => {
    expect(stampLivePage(comment(), '/checkout').pageUrl).toBe('/checkout');
    expect(stampLivePage(comment({ type: AnnotationType.GLOBAL_COMMENT }), '/checkout').pageUrl).toBeUndefined();
    expect(stampLivePage(comment(), '').pageUrl).toBeUndefined();
  });

  test("a reply keeps its parent's page, written from another page or with none", () => {
    expect(stampLivePage(comment({ inReplyTo: 'p', pageUrl: '/cart' }), '/checkout').pageUrl).toBe('/cart');
    expect(stampLivePage(comment({ inReplyTo: 'p' }), '/checkout').pageUrl).toBeUndefined();
  });
});
