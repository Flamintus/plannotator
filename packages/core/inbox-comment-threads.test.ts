import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from './inbox-attachments';
import type { InboxCommentReplyRecord } from './inbox-attachments';
import {
  INBOX_COMMENT_REPLIES_TITLE,
  inboxCommentLastReplies,
  inboxCommentRepliesFeedback,
  inboxCommentReplyAnnotation,
  INBOX_COMMENT_REPLY_TEXT_MAX,
  inboxCommentReplyId,
  inboxCommentReplyText,
  isInboxCommentReplyRecord,
  INBOX_OPEN_COMMENTS_SENT,
  INBOX_OPEN_COMMENTS_TITLE,
  inboxCommentRounds,
  inboxCommentState,
  inboxCommentThreads,
  inboxCommentsToCarry,
  inboxMovedLines,
  inboxOpenCommentsFeedback,
} from './inbox-comment-threads';

const agent = (id: string, created_at = '2026-11-04T09:00:00.000Z') => ({ id, author: { kind: 'agent' }, created_at });
const person = (id: string, created_at = '2026-11-04T09:00:00.000Z') => ({ id, author: { kind: 'person' }, created_at });

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

describe('the resolved state', () => {
  test('a sent comment is open until the person resolves it, and open again when they reopen it', () => {
    expect(inboxCommentState({})).toBe('open');
    expect(inboxCommentState({ resolved_at: null })).toBe('open');
    expect(inboxCommentState({ resolved_at: '2026-11-04T10:05:00.000Z' })).toBe('resolved');
    const threads = inboxCommentThreads([agent('msg_a1'), person('msg_p1')], [record('c1', { sent_reply_id: 'msg_p1', resolved_at: '2026-11-04T10:05:00.000Z' }), record('c2', { sent_reply_id: 'msg_p1' })]);
    expect(Object.fromEntries(threads.map((t) => [t.id, t.state]))).toEqual({ c1: 'resolved', c2: 'open' });
  });

  test('a reply under a resolved comment opens it again; one from before the resolution does not', () => {
    const resolved = { resolved_at: '2026-11-04T10:05:00.000Z' };
    expect(inboxCommentState(resolved, '2026-11-04T10:06:00.000Z')).toBe('open');
    expect(inboxCommentState(resolved, '2026-11-04T10:04:00.000Z')).toBe('resolved');
  });
});

describe('the open comments a reply sends again', () => {
  const ses = (id: string, session: string) => ({ id, author: { kind: 'agent', session }, created_at: '2026-11-04T09:00:00.000Z' });
  const to = new Map([
    ['msg_p1', 'ses_a'],
    ['msg_p2', 'ses_a'],
    ['msg_q1', 'ses_b'],
  ]);
  const sentTo = (message: { id: string }) => to.get(message.id) ?? null;
  const carried = (messages: { id: string; author: { kind: string; session?: string }; created_at: string }[], records: InboxAnnotationRecord[], session: string) =>
    inboxCommentsToCarry(messages, inboxCommentThreads(messages, records), session, sentTo).map((t) => t.id);

  test('the first reply to a session after it answered sends its open comments again, not the resolved ones', () => {
    const messages = [ses('msg_a1', 'ses_a'), person('msg_p1'), ses('msg_a2', 'ses_a')];
    const records = [record('c1', { sent_reply_id: 'msg_p1' }), record('c2', { sent_reply_id: 'msg_p1', resolved_at: '2026-11-04T10:05:00.000Z' })];
    expect(carried(messages, records, 'ses_a')).toEqual(['c1']);
  });

  test('nothing again before the session answered, nor in a second reply of the same round', () => {
    const records = [record('c1', { sent_reply_id: 'msg_p1' })];
    expect(carried([ses('msg_a1', 'ses_a'), person('msg_p1')], records, 'ses_a')).toEqual([]);
    expect(carried([ses('msg_a1', 'ses_a'), person('msg_p1'), ses('msg_a2', 'ses_a'), person('msg_p2')], records, 'ses_a')).toEqual([]);
  });

  test('every round sends again every comment still open from all earlier rounds', () => {
    const messages = [ses('msg_a1', 'ses_a'), person('msg_p1'), ses('msg_a2', 'ses_a'), person('msg_p2'), ses('msg_a3', 'ses_a')];
    const records = [record('c1', { sent_reply_id: 'msg_p1' }), record('c2', { sent_reply_id: 'msg_p2', resolved_at: null })];
    expect(carried(messages, records, 'ses_a').sort()).toEqual(['c1', 'c2']);
  });

  test("a guided review's comment is never sent again: the window cannot resolve it", () => {
    const messages = [ses('msg_a1', 'ses_a'), person('msg_p1'), ses('msg_a2', 'ses_a')];
    const guide = record('g1', { sent_reply_id: 'msg_p1', message: undefined, guide: { title: 'Review', file: 'src/a.ts', side: 'new', line_start: 3, line_end: 3 }, version: 'a'.repeat(64) });
    expect(carried(messages, [guide, record('c1', { sent_reply_id: 'msg_p1' })], 'ses_a')).toEqual(['c1']);
  });

  test("a comment that went to another session waits for a reply to that one", () => {
    const messages = [ses('msg_a1', 'ses_a'), ses('msg_b1', 'ses_b'), person('msg_q1'), ses('msg_b2', 'ses_b'), ses('msg_a2', 'ses_a')];
    const records = [record('c1', { sent_reply_id: 'msg_q1' })];
    expect(carried(messages, records, 'ses_a')).toEqual([]);
    expect(carried(messages, records, 'ses_b')).toEqual(['c1']);
  });

  test('as feedback: one entry per comment, named by its id with its round and place, the whole comment quoted', () => {
    expect(inboxOpenCommentsFeedback([], '/repo')).toBe('');
    const messages = [agent('msg_a1'), person('msg_p1')];
    const threads = inboxCommentThreads(messages, [
      record('c1', { sent_reply_id: 'msg_p1', annotation: { originalText: 'every\nstore', text: 'One store first.\nThen the rest.' } }),
      record('c2', {
        sent_reply_id: 'msg_p1',
        message: undefined,
        attachment_id: 'att_1',
        path: '/repo/notes.md',
        unanchored_at: '2026-11-04T11:00:00.000Z',
        annotation: { originalText: 'Ship on Friday.', text: 'Not on a Friday.' },
      }),
    ]);
    const text = inboxOpenCommentsFeedback(threads, '/repo');
    expect(text.startsWith(`# ${INBOX_OPEN_COMMENTS_TITLE}\n`)).toBe(true);
    const headings = text.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain('Round 1, on message msg_a1: "every store"');
    expect(headings[0]!.endsWith('(id c1)')).toBe(true);
    expect(headings[1]).toContain('on notes.md');
    expect(headings[1]).toContain('unanchored');
    expect(headings[1]!.endsWith('(id c2)')).toBe(true);
    // Every line of a comment stays in its quote, so the next heading starts a new entry.
    expect(text).toContain('> One store first.\n> Then the rest.');
  });

  test('as feedback, a long backlog sends the newest again and counts the rest', () => {
    const count = INBOX_OPEN_COMMENTS_SENT + 3;
    const ids = Array.from({ length: count }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const threads = inboxCommentThreads(
      [agent('msg_a1'), person('msg_p1')],
      ids.map((id, i) => record(id, { sent_reply_id: 'msg_p1', created_at: `2026-11-04T10:${String(i).padStart(2, '0')}:00.000Z` })),
    );
    const text = inboxOpenCommentsFeedback(threads, '/repo');
    const named = text.split('\n').filter((line) => line.startsWith('### ')).map((line) => /\(id (\w+)\)$/.exec(line)![1]);
    expect(named).toEqual(ids.slice(-INBOX_OPEN_COMMENTS_SENT));
    expect(text).toContain('3 older open comments');
  });
});

describe('replies under a sent comment', () => {
  // Round 1: msg_p1 carries c1; the agent answers (msg_a2); round 2: msg_p2 carries the person's reply r1.
  const messages = [
    agent('msg_a1', '2026-11-04T10:00:00.000Z'),
    person('msg_p1', '2026-11-04T10:01:00.000Z'),
    agent('msg_a2', '2026-11-04T10:05:00.000Z'),
    person('msg_p2', '2026-11-04T10:09:00.000Z'),
  ];
  const comment = record('c1', { sent_reply_id: 'msg_p1', created_at: '2026-11-04T10:00:30.000Z' });
  const agentReply = (id: string, created_at: string, re = 'c1'): InboxCommentReplyRecord => ({
    id,
    project_id: 'prj_1',
    thread_id: 'msg_a1',
    re,
    from: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' },
    message_id: 'msg_a2',
    text: `answer ${id}`,
    created_at,
  });
  const personReply = (id: string, fields: Partial<InboxAnnotationRecord> = {}) =>
    record(id, { re: 'c1', annotation: { id, type: 'COMMENT', originalText: 'words of c1', text: `reply ${id}`, inReplyTo: 'c1' }, ...fields });

  test("one flat list under the comment, oldest first: the agent's and the person's sent ones, each with its author and round", () => {
    const threads = inboxCommentThreads(
      messages,
      [comment, personReply('r1', { sent_reply_id: 'msg_p2', created_at: '2026-11-04T10:08:00.000Z' }), personReply('draft')],
      [agentReply('rep_a', '2026-11-04T10:04:00.000Z'), agentReply('rep_b', '2026-11-04T10:10:00.000Z')],
    );
    // The person's reply is not a comment of its own, and a draft is not sent yet.
    expect(threads.map((t) => t.id)).toEqual(['c1']);
    expect(threads[0]!.replies.map((r) => [r.id, r.author.kind, r.round])).toEqual([
      ['rep_a', 'agent', 1],
      ['r1', 'person', 2],
      // Written after round 2's Send: round 2, though the comment it is under is round 1.
      ['rep_b', 'agent', 2],
    ]);
    expect(threads[0]!.replies[0]).toMatchObject({ author: { kind: 'agent', name: 'Claude Code', session: 'ses_a', host: 'claude-code' }, text: 'answer rep_a' });
    expect(threads[0]!.replies[1]).toMatchObject({ text: 'reply r1' });
  });

  test('a Send that carries only a reply is a round', () => {
    expect(Object.fromEntries(inboxCommentRounds(messages, [comment, personReply('r1', { sent_reply_id: 'msg_p2' })]))).toEqual({ msg_p1: 1, msg_p2: 2 });
  });

  test('a reply newer than the resolution opens the comment again; an older one does not', () => {
    const resolved = { ...comment, resolved_at: '2026-11-04T10:06:00.000Z' };
    expect(inboxCommentThreads(messages, [resolved], [agentReply('rep_a', '2026-11-04T10:04:00.000Z')])[0]!.state).toBe('resolved');
    expect(inboxCommentThreads(messages, [resolved], [agentReply('rep_b', '2026-11-04T10:07:00.000Z')])[0]!.state).toBe('open');
    expect(inboxCommentThreads(messages, [resolved, personReply('r1', { sent_reply_id: 'msg_p2', created_at: '2026-11-04T10:08:00.000Z' })])[0]!.state).toBe('open');
    // A draft is not sent: what the agent reads stays resolved.
    expect(inboxCommentThreads(messages, [resolved, personReply('draft', { created_at: '2026-11-04T10:08:00.000Z' })])[0]!.state).toBe('resolved');
  });

  test("the newest reply's time by comment: drafts count (the window draws them), removed ones do not", () => {
    const last = inboxCommentLastReplies(
      [comment, personReply('draft', { created_at: '2026-11-04T10:08:00.000Z' }), personReply('gone', { created_at: '2026-11-04T10:20:00.000Z', removed_at: '2026-11-04T10:21:00.000Z' })],
      [agentReply('rep_a', '2026-11-04T10:04:00.000Z')],
    );
    expect(Object.fromEntries(last)).toEqual({ c1: '2026-11-04T10:08:00.000Z' });
  });

  test("the person's reply takes the comment's place and keeps its own words", () => {
    const parent = record('c1', {
      annotation: { id: 'c1', type: 'DELETION', blockId: 'b3', startOffset: 4, endOffset: 9, originalText: 'Friday', text: 'no', author: 'Swift Tater', images: [{ path: '/x.png', name: 'x' }], inboxCode: { lineStart: 2, lineEnd: 3, code: 'x' }, diagramAnchor: { v: 1 } },
    });
    const reply = inboxCommentReplyAnnotation(parent, { id: 'r1', text: 'Tuesday then', createdA: 5, mentions: ['pi'] });
    expect(reply).toEqual({ blockId: 'b3', startOffset: 4, endOffset: 9, originalText: 'Friday', inboxCode: { lineStart: 2, lineEnd: 3, code: 'x' }, diagramAnchor: { v: 1 }, id: 'r1', type: 'COMMENT', text: 'Tuesday then', createdA: 5, mentions: ['pi'], inReplyTo: 'c1' });
  });

  test('as feedback: one entry per reply, under the id of its comment, where it is, and its own id', () => {
    expect(inboxCommentRepliesFeedback([comment], '/repo')).toBe('');
    const onFile = personReply('r2', { message: undefined, attachment_id: 'att_1', path: '/repo/notes.md', created_at: '2026-11-04T10:09:00.000Z', annotation: { originalText: 'Ship on\nFriday.', text: 'Tuesday.\nEU first.', inReplyTo: 'c9' }, re: 'c9' });
    const text = inboxCommentRepliesFeedback([onFile, personReply('r1', { created_at: '2026-11-04T10:08:00.000Z' })], '/repo');
    expect(text.startsWith(`# ${INBOX_COMMENT_REPLIES_TITLE}\n`)).toBe(true);
    const headings = text.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual(['### 1. Reply under comment c1, on message msg_a1: "words of c1" (id r1)', '### 2. Reply under comment c9, on notes.md: "Ship on Friday." (id r2)']);
    expect(text).toContain('> Tuesday.\n> EU first.');
  });

  test("a stored line is an agent's reply only when it reads as one: a reader skips a malformed or newer one", () => {
    const good = agentReply(inboxCommentReplyId(0), '2026-11-04T10:04:00.000Z');
    expect(isInboxCommentReplyRecord(good)).toBe(true);
    for (const bad of [{ ...good, id: 'c1' }, { ...good, from: { kind: 'person' } }, { ...good, from: { ...good.from, name: 3 } }, { ...good, message_id: undefined }, { ...good, text: null }, null]) {
      expect(isInboxCommentReplyRecord(bad)).toBe(false);
    }
  });

  test("a reply's words are kept trimmed, refused empty or too long", () => {
    expect(inboxCommentReplyText('  Tuesday.  ')).toBe('Tuesday.');
    expect(inboxCommentReplyText(' \n ')).toBeNull();
    expect(inboxCommentReplyText('x'.repeat(INBOX_COMMENT_REPLY_TEXT_MAX + 1))).toBeNull();
    expect(inboxCommentReplyText(4)).toBeNull();
  });
});
