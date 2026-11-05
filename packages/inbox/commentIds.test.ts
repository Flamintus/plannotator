/**
 * The comment ids an agent reads in a Send's feedback. Failures this catches:
 * a comment on a message's words, on a file, or on a guided review's diff
 * reaching the agent without the id the store keeps for it, so the agent
 * cannot name that comment later; an id that follows the comment's place (its
 * number restarts in every section) instead of the comment. The guided
 * review's sections without ids stay the review app's export
 * (guideFeedback.test.ts); and ui's id rule drifting from the store's, so a
 * stored comment would reach the agent without its id.
 */
import { describe, expect, test } from 'bun:test';
import { isInboxAnnotationId, type InboxAnnotationRecord, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { commentIdSuffix } from '@plannotator/ui/utils/parser';
import { attachmentFeedback } from './attachments';

const AT = '2026-11-04T10:00:00.000Z';
const NOTES: InboxAttachmentState = {
  id: 'att_01K7VVVVVVVVVVVVVVVVVVVVVV',
  path: '/work/shop/docs/rollout.md',
  named_path: null,
  name: 'rollout.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: 40,
  sent_at: AT,
  sent_mtime: AT,
  message_id: 'msg_A',
  current: null,
  changed_since_sent: false,
  unavailable: null,
};
const TEXT = '# Rollout\n\nShip to all stores.\n\nRoll back by hand.\n';

function record(id: string, target: Partial<InboxAnnotationRecord>, annotation: Record<string, unknown>): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_A',
    message_id: 'msg_A',
    attachment_id: '',
    path: '',
    version: 'current',
    annotation: { id, startOffset: 0, endOffset: 1, type: 'COMMENT', createdA: 1, ...annotation },
    created_at: AT,
    updated_at: AT,
    removed_at: null,
    sent_reply_id: null,
    ...target,
  };
}

const onWords = (id: string, words: string) =>
  record(id, { path: 'msg_A', message: { at: AT } }, { blockId: 'block-0', text: 'Why?', originalText: words });
const onFile = (id: string, words: string, blockId: string) =>
  record(id, { attachment_id: NOTES.id, path: NOTES.path }, { blockId, text: 'Which stores?', originalText: words });
const onDiff = (id: string, line: number): InboxAnnotationRecord => {
  const comment: CodeAnnotation = { id, type: 'comment', scope: 'line', filePath: 'src/retry.ts', lineStart: line, lineEnd: line, side: 'new', text: 'Cap it.', createdAt: line };
  return record(id, { path: comment.filePath, version: 'f'.repeat(64), guide: { title: 'Retry', file: comment.filePath, side: 'new', line_start: line, line_end: line } }, comment as unknown as Record<string, unknown>);
};

const send = (records: InboxAnnotationRecord[]) => attachmentFeedback(records, [NOTES], new Map([[`${NOTES.id}\0current`, TEXT]]), '/work/shop');

/** The comment heading (`### …`) that names `id`, or undefined. */
const headingOf = (text: string, id: string) => text.split('\n').find((line) => line.startsWith('### ') && line.endsWith(` (id ${id})`));

describe('comment ids in what a Send carries', () => {
  test("a comment on a message's words, on a file and on a guided review's diff each name the record's id", () => {
    const text = send([onWords('ann-words', 'two, four and eight seconds'), onFile('ann-file', 'Ship to all stores.', 'block-1'), onDiff('ann-diff', 12)]);
    expect(headingOf(text, 'ann-words')).toBe('### 1. Feedback on: "two, four and eight seconds" (id ann-words)');
    expect(headingOf(text, 'ann-file')).toBe('### 1. (line 3) Feedback on: "Ship to all stores." (id ann-file)');
    expect(headingOf(text, 'ann-diff')).toBe('### Line 12 (new) (id ann-diff)');
  });

  test("a global comment on a guided review has no heading: its id ends the comment's text", () => {
    const comment: CodeAnnotation = { id: 'ann-global', type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new', text: 'Split the retry into its own PR.', createdAt: 1 };
    const global = record('ann-global', { path: '', version: 'f'.repeat(64), guide: { title: 'Retry', file: '', side: 'new', line_start: 0, line_end: 0 } }, comment as unknown as Record<string, unknown>);
    const text = send([global, onDiff('ann-diff', 12)]);
    expect(text.split('\n')).toContain('Split the retry into its own PR. (id ann-global)');
    expect(headingOf(text, 'ann-diff')).toBe('### Line 12 (new) (id ann-diff)');
  });

  test('words on several lines keep their fence; the id ends the heading above it', () => {
    const text = send([onWords('ann-across', 'Ship it.\n\nThen tag it.')]);
    expect(text).toContain('### 1. Feedback on: (id ann-across)\n```\nShip it.\n\nThen tag it.\n```\n');
  });

  test('ui prints an id exactly when the store keeps it (parser.ts holds its own copy of the rule)', () => {
    const ids = ['ann-code-1', 'global-1', '0f8b2c4e-91d3-4a57-b6e0-3c2d1f9a8e70', 'a:b.c_d-e', 'x'.repeat(200), 'x'.repeat(201), '', 'two words', 'a\nb', 'a/b', 'é', 'a)'];
    for (const id of ids) expect([id, commentIdSuffix(id) !== '']).toEqual([id, isInboxAnnotationId(id)]);
  });

  test('the id is the comment\'s, not its place: a comment keeps it when another comes before it', () => {
    const later = onFile('ann-later', 'Roll back by hand.', 'block-2');
    expect(headingOf(send([later]), 'ann-later')).toStartWith('### 1. ');
    expect(headingOf(send([onFile('ann-first', 'Ship to all stores.', 'block-1'), later]), 'ann-later')).toStartWith('### 2. ');
  });
});
