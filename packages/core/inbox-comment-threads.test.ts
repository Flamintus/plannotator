import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from './inbox-attachments';
import { inboxCommentRounds, inboxCommentThreads, inboxMovedLines } from './inbox-comment-threads';

const agent = (id: string) => ({ id, author: { kind: 'agent' } });
const person = (id: string) => ({ id, author: { kind: 'person' } });

function record(id: string, fields: Partial<InboxAnnotationRecord> & { annotation?: Record<string, unknown> } = {}): InboxAnnotationRecord {
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
    created_at: `2026-11-04T10:00:0${id.length % 10}.000Z`,
    updated_at: '2026-11-04T10:00:00.000Z',
    removed_at: null,
    sent_reply_id: null,
    ...fields,
  };
}

describe('rounds of sent comments', () => {
  test('each reply that carried comments after an agent wrote is the next round', () => {
    const messages = [agent('msg_a1'), person('msg_p1'), agent('msg_a2'), person('msg_p2'), agent('msg_a3'), person('msg_p3')];
    const records = [record('c1', { sent_reply_id: 'msg_p1' }), record('c2', { sent_reply_id: 'msg_p3' })];
    // msg_p2 carried no comment: it is no round, and the next carrier is round 2, not 3.
    expect([...inboxCommentRounds(messages, records)]).toEqual([
      ['msg_p1', 1],
      ['msg_p3', 2],
    ]);
  });

  test('replies with no agent message between them share their round (one Send to two sessions)', () => {
    const messages = [agent('msg_a1'), agent('msg_b1'), person('msg_p1'), person('msg_p2'), agent('msg_a2'), person('msg_p3')];
    const records = [record('c1', { sent_reply_id: 'msg_p1' }), record('c2', { sent_reply_id: 'msg_p2' }), record('c3', { sent_reply_id: 'msg_p3' })];
    expect(Object.fromEntries(inboxCommentRounds(messages, records))).toEqual({ msg_p1: 1, msg_p2: 1, msg_p3: 2 });
  });

  test('drafts and removed comments make no round', () => {
    const messages = [agent('msg_a1'), person('msg_p1')];
    expect(inboxCommentRounds(messages, [record('c1'), record('c2', { removed_at: 'x', sent_reply_id: 'msg_p1' })]).size).toBe(0);
  });
});

describe('the thread of sent comments', () => {
  const messages = [agent('msg_a1'), person('msg_p1'), agent('msg_a2'), person('msg_p2')];

  test('lists only sent comments, round by round, with where each is and whether it lost its words', () => {
    const records = [
      record('late', { sent_reply_id: 'msg_p2', created_at: '2026-11-04T09:00:00.000Z' }),
      record('draft'),
      record('file', {
        sent_reply_id: 'msg_p1',
        message: undefined,
        attachment_id: 'att_1',
        path: '/repo/src/app.ts',
        annotation: { id: 'file', originalText: 'const a = 1;', text: 'rename it', inboxCode: { lineStart: 12, lineEnd: 14, code: 'x' } },
        unanchored_at: '2026-11-04T11:00:00.000Z',
      }),
      record('guide', {
        sent_reply_id: 'msg_p1',
        message: undefined,
        guide: { title: 'Review', file: 'src/a.ts', side: 'new', line_start: 3, line_end: 3 },
        version: 'a'.repeat(64),
        annotation: { id: 'guide', text: 'why?' },
      }),
      record('video', { sent_reply_id: 'msg_p1', message: undefined, attachment_id: 'att_2', path: '/repo/cut.mp4', version: 'b'.repeat(64), annotation: { id: 'video', text: 'here', inboxVideo: { time: 102.4 } } }),
    ];
    const threads = inboxCommentThreads(messages, records);
    // Round 1 before round 2, even though round 2's comment was made first.
    expect(threads.map((t) => [t.id, t.round])).toEqual([
      ['file', 1],
      ['guide', 1],
      ['video', 1],
      ['late', 2],
    ]);
    expect(threads.every((t) => t.state === 'open')).toBe(true);
    const byId = new Map(threads.map((t) => [t.id, t]));
    expect(byId.get('file')).toMatchObject({ reply_id: 'msg_p1', quote: 'const a = 1;', text: 'rename it', unanchored: true, on: { kind: 'file', path: '/repo/src/app.ts', version: 'current', lines: [12, 14] } });
    expect(byId.get('guide')!.on).toEqual({ kind: 'guide', message_id: 'msg_a1', file: 'src/a.ts', side: 'new', lines: [3, 3] });
    expect(byId.get('video')!.on).toEqual({ kind: 'file', path: '/repo/cut.mp4', version: 'sent', at: 102.4 });
    expect(byId.get('late')).toMatchObject({ on: { kind: 'message', message_id: 'msg_a1' }, unanchored: false });
  });

  test('a comment whose reply is not in the thread (a Send that never landed) is left out', () => {
    expect(inboxCommentThreads(messages, [record('lost', { sent_reply_id: 'msg_gone' })])).toEqual([]);
  });
});

describe('where a run of lines moved to', () => {
  const file = ['a', 'b', 'target 1', 'target 2', 'c'];
  const reads = (text: string) => text === 'target 1\ntarget 2';

  test('lines still in place stay', () => {
    expect(inboxMovedLines(file, 3, 2, reads)).toBe(3);
  });

  test('lines added or removed above them move them', () => {
    expect(inboxMovedLines(['new', 'new', ...file], 3, 2, reads)).toBe(5);
    expect(inboxMovedLines(file.slice(2), 3, 2, reads)).toBe(1);
  });

  test('the nearest copy wins when the lines read the same twice', () => {
    const twice = ['target 1', 'target 2', 'x', 'x', 'x', 'x', 'target 1', 'target 2'];
    expect(inboxMovedLines(twice, 6, 2, reads)).toBe(7);
    expect(inboxMovedLines(twice, 2, 2, reads)).toBe(1);
  });

  test('lines no longer anywhere are lost', () => {
    expect(inboxMovedLines(['a', 'target 1', 'changed'], 2, 2, reads)).toBeNull();
    expect(inboxMovedLines(['target 1'], 1, 2, reads)).toBeNull();
  });
});
