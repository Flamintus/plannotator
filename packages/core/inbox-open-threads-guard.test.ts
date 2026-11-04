import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from './inbox-attachments';
import { inboxOpenCommentThreads } from './inbox-open-threads-guard';

function record(id: string, fields: Partial<InboxAnnotationRecord> = {}): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_1',
    thread_id: 'msg_a1',
    message_id: 'msg_a1',
    attachment_id: '',
    path: 'msg_a1',
    version: 'current',
    message: { at: '2026-11-04T10:00:00.000Z' },
    annotation: { id, type: 'COMMENT', originalText: `words of ${id}`, text: `comment ${id}` },
    created_at: '2026-11-04T10:00:00.000Z',
    updated_at: '2026-11-04T10:00:00.000Z',
    removed_at: null,
    sent_reply_id: 'msg_p1',
    ...fields,
  };
}

const agentReply = (id: string, re: string, created_at: string): InboxCommentReplyRecord => ({
  id,
  project_id: 'prj_1',
  thread_id: 'msg_a1',
  re,
  from: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' },
  message_id: 'msg_a2',
  text: `answer ${id}`,
  created_at,
});

const RESOLVED = '2026-11-04T11:00:00.000Z';
const ids = (records: readonly InboxAnnotationRecord[]) => records.map((r) => r.id);

describe('the comment threads that hold the archive', () => {
  test('a sent comment holds it until the person resolves it; a draft or a removed one never does', () => {
    const sent = [record('open'), record('done', { resolved_at: RESOLVED }), record('gone', { removed_at: RESOLVED }), record('draft', { sent_reply_id: null })];
    expect(ids(inboxOpenCommentThreads(sent, []))).toEqual(['open']);
  });

  test('a reply newer than its resolution opens a comment again, the agent\'s or the person\'s draft; an older one or a removed draft does not', () => {
    const sent = [record('c1', { resolved_at: RESOLVED }), record('c2', { resolved_at: RESOLVED }), record('c3', { resolved_at: RESOLVED }), record('c4', { resolved_at: RESOLVED })];
    const drafts = [
      record('d3', { re: 'c3', sent_reply_id: null, created_at: '2026-11-04T12:00:00.000Z' }),
      record('d4', { re: 'c4', sent_reply_id: null, created_at: '2026-11-04T12:00:00.000Z', removed_at: '2026-11-04T12:01:00.000Z' }),
    ];
    const replies = [agentReply('rep_1', 'c1', '2026-11-04T12:00:00.000Z'), agentReply('rep_2', 'c2', '2026-11-04T10:30:00.000Z')];
    expect(ids(inboxOpenCommentThreads(sent, drafts, replies))).toEqual(['c1', 'c3']);
  });

  test('a reply is part of its comment\'s thread, never a thread that holds it', () => {
    const sent = [record('c1', { resolved_at: RESOLVED }), record('r1', { re: 'c1', created_at: '2026-11-04T09:00:00.000Z' })];
    expect(ids(inboxOpenCommentThreads(sent, []))).toEqual([]);
  });

  test('a sub-thread holds it on its own: open under a resolved comment, and not once resolved under an open one', () => {
    const resolvedParent = [record('c1', { resolved_at: RESOLVED }), record('s1', { parent: 'rep_1', quote_offset: 0 })];
    expect(ids(inboxOpenCommentThreads(resolvedParent, [], [agentReply('rep_1', 'c1', '2026-11-04T10:30:00.000Z')]))).toEqual(['s1']);
    const resolvedSub = [record('c1'), record('s1', { parent: 'c1', quote_offset: 0, resolved_at: RESOLVED })];
    expect(ids(inboxOpenCommentThreads(resolvedSub, []))).toEqual(['c1']);
  });

  test("a guided review's comment never holds it, nor a sub-thread in its place: the window draws none, so none can be resolved", () => {
    const guide: InboxAnnotationRecord['guide'] = { title: 'Review', file: 'src/a.ts', side: 'new', line_start: 1, line_end: 2 };
    const sent = [record('g1', { message: undefined, guide }), record('gs1', { message: undefined, guide, parent: 'g1', quote_offset: 0 }), record('c1')];
    expect(ids(inboxOpenCommentThreads(sent, []))).toEqual(['c1']);
  });
});
