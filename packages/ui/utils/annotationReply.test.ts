/**
 * The one reply builder behind a person's Reply and a browser agent's
 * `add_comments { inReplyTo }`. A dropped anchor puts the reply somewhere
 * else: text search paints a diagram node's label wherever the prose repeats
 * it, a live-app reply lands on another page, a plan-diff reply leaves the
 * diff.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import { buildReplyAnnotation } from './annotationReply';

const PARENT: Annotation = {
  id: 'p',
  blockId: 'block-3',
  startOffset: 4,
  endOffset: 19,
  type: AnnotationType.COMMENT,
  text: 'Why a cron job?',
  originalText: 'a nightly cron job',
  createdA: 1,
  author: 'browser-agent',
  source: 'browser-agent',
  images: [{ path: '/tmp/shot.png', name: 'shot' }],
  isQuickLabel: true,
  startMeta: { parentTagName: 'P', parentIndex: 2, textOffset: 4 },
  endMeta: { parentTagName: 'P', parentIndex: 2, textOffset: 19 },
  htmlAnchor: { selector: '#job', tagName: 'P' },
  diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'cron', label: 'cron', sourceLine: [7, 7] },
  pageUrl: '/jobs',
  diffContext: 'modified',
};

describe('buildReplyAnnotation', () => {
  test("takes the parent's place and every anchor, names the parent, and keeps only the reply's own words and author", () => {
    const reply = buildReplyAnnotation(PARENT, { id: 'r', text: 'It runs once a night.', createdA: 2, author: 'Swift Tater' });
    expect(reply).toEqual({
      id: 'r',
      blockId: 'block-3',
      startOffset: 4,
      endOffset: 19,
      type: AnnotationType.COMMENT,
      text: 'It runs once a night.',
      originalText: 'a nightly cron job',
      createdA: 2,
      author: 'Swift Tater',
      inReplyTo: 'p',
      startMeta: PARENT.startMeta,
      endMeta: PARENT.endMeta,
      htmlAnchor: PARENT.htmlAnchor,
      diagramAnchor: PARENT.diagramAnchor,
      pageUrl: '/jobs',
      diffContext: 'modified',
    });
  });

  test('a reply to a deletion is a comment, a reply to a global comment is global', () => {
    const fields = { id: 'r', text: 'ok', createdA: 2 };
    expect(buildReplyAnnotation({ ...PARENT, type: AnnotationType.DELETION }, fields).type).toBe(AnnotationType.COMMENT);
    expect(buildReplyAnnotation({ ...PARENT, type: AnnotationType.GLOBAL_COMMENT }, fields).type).toBe(AnnotationType.GLOBAL_COMMENT);
  });

  test('mentions ride only when a pick survived', () => {
    const fields = { id: 'r', text: 'ok', createdA: 2 };
    expect('mentions' in buildReplyAnnotation(PARENT, { ...fields, mentions: [] })).toBe(false);
    expect(buildReplyAnnotation(PARENT, { ...fields, mentions: ['user_1'] }).mentions).toEqual(['user_1']);
  });
});
