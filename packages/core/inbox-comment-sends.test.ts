import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from './inbox-attachments';
import {
  INBOX_COMMENT_THREAD_VIEW_VERSION,
  inboxCommentDraftIsLive,
  inboxCommentSendAddress,
  inboxCommentSendId,
  inboxCommentSendRoutes,
  inboxCommentSendStatus,
  inboxCommentEntryNotes,
  inboxCommentRoundCount,
  inboxCommentSendText,
  inboxCommentsWake,
  inboxCommentThreadView,
  inboxQuoteLines,
  inboxLiveCommentThreads,
  inboxOpenCommentsToName,
  isInboxCommentSendable,
  inboxWordsMessage,
  isInboxCommentSendRecord,
  type InboxCommentSend,
  type InboxCommentSendMessage,
} from './inbox-comment-sends';
import { INBOX_OPEN_COMMENTS_SENT, inboxCommentRoundNow, inboxCommentRounds, inboxCommentThreads } from './inbox-comment-threads';

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`;
const agent = (id: string, minute: number, session = 'ses_a') => ({ id, author: { kind: 'agent', session }, created_at: at(minute) });
const person = (id: string, minute: number) => ({ id, author: { kind: 'person' }, created_at: at(minute) });

function record(id: string, fields: Partial<InboxAnnotationRecord> & { annotation?: Record<string, unknown> } = {}): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_1',
    thread_id: 'msg_a1',
    message_id: 'msg_a1',
    attachment_id: '',
    path: 'msg_a1',
    version: 'current',
    message: { at: at(0) },
    annotation: { id, type: 'COMMENT', originalText: `words of ${id}`, text: `comment ${id}` },
    created_at: at(1),
    updated_at: at(1),
    removed_at: null,
    sent_reply_id: null,
    ...fields,
  };
}

function send(id: string, minute: number, fields: Partial<InboxCommentSend> = {}): InboxCommentSend {
  return {
    id,
    project_id: 'prj_1',
    thread_id: 'msg_a1',
    batch: id,
    to: { host: 'claude-code', session: 'ses_a' },
    round: 1,
    mode: 'now',
    comments: [],
    with_message: null,
    idempotency_key: null,
    created_at: at(minute),
    ...fields,
  };
}

function agentReply(id: string, re: string, minute: number, session = 'ses_a'): InboxCommentReplyRecord {
  return {
    id,
    project_id: 'prj_1',
    thread_id: 'msg_a1',
    re,
    from: { kind: 'agent', host: 'claude-code', session, name: 'Claude Code' },
    message_id: '',
    text: `answer ${id}`,
    created_at: at(minute),
  };
}

const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('### '));

describe('rounds of comment sends', () => {
  test('a `now` send leaves the round open whoever writes after it; only a Finish ends it, even one that carries no draft', () => {
    const messages = [agent('msg_a1', 0), agent('msg_a2', 5), agent('msg_a3', 15)];
    const sends = [send('snd_1', 2), send('snd_2', 6), send('snd_3', 8, { mode: 'round' }), send('snd_4', 10, { mode: 'round' }), send('snd_5', 20)];
    expect(Object.fromEntries(inboxCommentRounds(messages, [], sends))).toEqual({ snd_1: 1, snd_2: 1, snd_3: 1, snd_4: 2, snd_5: 3 });
    expect(inboxCommentRoundNow(messages, [], sends)).toBe(3);
    expect(inboxCommentRoundNow(messages, [], sends.slice(0, 4))).toBe(3);
    expect(inboxCommentRoundNow(messages, [], [])).toBe(1);
  });

  test("the sends continue the rounds the person's replies carried, in the thread's order", () => {
    // Two rounds carried by replies, each answered by the agent; then sends.
    const messages = [agent('msg_a1', 0), person('msg_p1', 1), agent('msg_a2', 2), person('msg_p2', 3), agent('msg_a3', 4)];
    const records = [record('c1', { sent_reply_id: 'msg_p1' }), record('c2', { sent_reply_id: 'msg_p2' })];
    expect(inboxCommentRoundNow(messages, records, [])).toBe(3);
    const sends = [send('snd_1', 5), send('snd_2', 6, { mode: 'round' })];
    expect(Object.fromEntries(inboxCommentRounds(messages, records, sends))).toEqual({ msg_p1: 1, msg_p2: 2, snd_1: 3, snd_2: 3 });
    expect(inboxCommentRoundNow(messages, records, sends)).toBe(4);
  });

  test('the sends of one press, one per session, are one step: a Finish to two sessions ends one round', () => {
    const b = { host: 'pi', session: 'ses_b' };
    const sends = [
      send('snd_1a', 2, { mode: 'round' }),
      send('snd_1b', 2, { batch: 'snd_1a', mode: 'round', to: b }),
      send('snd_2a', 5),
      send('snd_2b', 5, { batch: 'snd_2a', to: b }),
    ];
    expect(Object.fromEntries(inboxCommentRounds([agent('msg_a1', 0)], [], sends))).toEqual({ snd_1a: 1, snd_1b: 1, snd_2a: 2, snd_2b: 2 });
    expect(inboxCommentRoundNow([agent('msg_a1', 0)], [], sends)).toBe(2);
  });

  test("a reply that carried comments inside a round sends opened waits for the agent's answer, which ends the round", () => {
    const messages = [agent('msg_a1', 0), person('msg_p1', 6), agent('msg_a2', 8)];
    const records = [record('c1', { sent_reply_id: 'msg_p1' })];
    expect(Object.fromEntries(inboxCommentRounds(messages, records, [send('snd_1', 2)]))).toEqual({ snd_1: 1, msg_p1: 1 });
    expect(inboxCommentRoundNow(messages, records, [send('snd_1', 2)])).toBe(2);
  });

  test("a send before the agent answered the person's reply is in that reply's round", () => {
    const messages = [agent('msg_a1', 0), person('msg_p1', 1), agent('msg_a2', 9)];
    const records = [record('c1', { sent_reply_id: 'msg_p1' })];
    expect(Object.fromEntries(inboxCommentRounds(messages, records, [send('snd_1', 3), send('snd_2', 10)]))).toEqual({ msg_p1: 1, snd_1: 1, snd_2: 1 });
  });

  test('each send written with the round under way keeps that round once later sends come', () => {
    const messages = [agent('msg_a1', 0), person('msg_p1', 1), agent('msg_a2', 2)];
    const records = [record('c1', { sent_reply_id: 'msg_p1' })];
    const sends: InboxCommentSend[] = [];
    ['now', 'round', 'now', 'now', 'round', 'round', 'now'].forEach((mode, index) => {
      sends.push(send(`snd_${index}`, 10 + index, { mode: mode as InboxCommentSend['mode'], round: inboxCommentRoundNow(messages, records, sends) }));
    });
    const rounds = inboxCommentRounds(messages, records, sends);
    expect(sends.map((s) => rounds.get(s.id))).toEqual(sends.map((s) => s.round));
    expect(sends.map((s) => s.round)).toEqual([2, 2, 3, 3, 3, 4, 5]);
  });

  test("a comment has its send's round; the agent's reply, the round of the newest send its session had received", () => {
    const messages = [agent('msg_a1', 0)];
    const records = [record('c1', { sent_reply_id: 'snd_1' }), record('c2', { sent_reply_id: 'snd_2', created_at: at(6) }), record('lost', { sent_reply_id: 'snd_gone' })];
    const sends = [
      send('snd_1', 2, { mode: 'round', comments: ['c1'], delivery: { state: 'delivered', host: 'claude-code', session: 'ses_a', at: at(3) } }),
      // Round 2, still waiting for its session to take it.
      send('snd_2', 6, { comments: ['c2'] }),
      // Round 2 too, read by another session only.
      send('snd_3', 7, { to: { host: 'pi', session: 'ses_b' }, read_at: at(8) }),
    ];
    const threads = inboxCommentThreads(messages, records, [agentReply('rep_1', 'c1', 9)], sends);
    // A comment whose send is not given (one that never landed) is left out.
    expect(threads.map((t) => [t.id, t.round, t.reply_id])).toEqual([
      ['c1', 1, 'snd_1'],
      ['c2', 2, 'snd_2'],
    ]);
    expect(threads[0]!.replies.map((r) => r.round)).toEqual([1]);
    const delivered = sends.map((s) => (s.id === 'snd_2' ? { ...s, delivery: { state: 'delivered' as const, host: 'claude-code', session: 'ses_a', at: at(8) } } : s));
    expect(inboxCommentThreads(messages, records, [agentReply('rep_1', 'c1', 9)], delivered)[0]!.replies.map((r) => r.round)).toEqual([2]);
  });

  test('a session a send tags answers in the round of the newest send that reached it', () => {
    const tagged = (minute: number | null) => [{ host: 'pi', session: 'ses_b', wakes: true, delivery: minute === null ? null : { state: 'delivered' as const, host: 'pi', session: 'ses_b', at: at(minute) } }];
    const records = [record('c1', { sent_reply_id: 'snd_1' })];
    const sends = (second: number | null) => [send('snd_1', 2, { mode: 'round', comments: ['c1'], tags: tagged(3) }), send('snd_2', 5, { tags: tagged(second) })];
    const round = (second: number | null) => inboxCommentThreads([agent('msg_a1', 0)], records, [agentReply('rep_b', 'c1', 7, 'ses_b')], sends(second))[0]!.replies[0]!.round;
    expect(round(6)).toBe(2);
    expect(round(null)).toBe(1);
  });
});

describe("the header's count", () => {
  test('the round under way, whether a send went in it (a Finish then ends it), and the sent threads still open', () => {
    const messages = [agent('msg_a1', 0)];
    const c1 = record('c1', { sent_reply_id: 'snd_1' });
    const c2 = record('c2', { sent_reply_id: 'snd_1', resolved_at: at(4) });
    const guide = record('g1', { sent_reply_id: 'snd_1', message: undefined, guide: { title: 'Review', file: 'src/a.ts', side: 'new', line_start: 3, line_end: 3 }, version: 'a'.repeat(64) });
    const sub = record('s1', { sent_reply_id: 'snd_2', parent: 'c1' });
    const draft = record('c3');
    // Nothing sent yet: round 1, no send in it, none open (a draft is not counted).
    expect(inboxCommentRoundCount({ messages, records: [draft] })).toEqual({ round: 1, started: false, open: 0 });
    // A `now` send went: round 1 started; c1 and its sub-thread open, c2 resolved, a guided review's never counted.
    const now = [send('snd_1', 2), send('snd_2', 3)];
    expect(inboxCommentRoundCount({ messages, records: [c1, c2, guide, sub, draft], sends: now })).toEqual({ round: 1, started: true, open: 2 });
    // The Finish ends it: round 2 under way, nothing sent in it yet; what is open stays open.
    const finished = [...now, send('snd_3', 5, { mode: 'round' })];
    expect(inboxCommentRoundCount({ messages, records: [c1, c2, guide, sub], sends: finished })).toEqual({ round: 2, started: false, open: 2 });
    // An agent's reply newer than the resolution opens c2 again.
    expect(inboxCommentRoundCount({ messages, records: [c1, c2, sub], sends: finished, agentReplies: [agentReply('rep_1', 'c2', 6)] }).open).toBe(3);
  });
});

describe('what a Finish names as still open', () => {
  test("the threads sent to that session before, still open, never a guided review's", () => {
    const messages = [agent('msg_a1', 0), agent('msg_b1', 0, 'ses_b')];
    const records = [
      record('c1', { sent_reply_id: 'snd_1' }),
      record('c2', { sent_reply_id: 'snd_1', resolved_at: at(5) }),
      record('c3', { sent_reply_id: 'snd_2' }),
      record('g1', { sent_reply_id: 'snd_1', message: undefined, guide: { title: 'Review', file: 'a.ts', side: 'new', line_start: 1, line_end: 1 }, version: 'a'.repeat(64) }),
    ];
    const sends = [send('snd_1', 2), send('snd_2', 3, { to: { host: 'pi', session: 'ses_b' } })];
    const threads = inboxCommentThreads(messages, records, [], sends);
    const sentTo = (carrier: string) => sends.find((s) => s.id === carrier)?.to.session ?? null;
    expect(inboxOpenCommentsToName(threads, 'ses_a', sentTo).map((t) => t.id)).toEqual(['c1']);
    expect(inboxOpenCommentsToName(threads, 'ses_b', sentTo).map((t) => t.id)).toEqual(['c3']);
  });
});

describe('live threads', () => {
  const records = [
    record('c1', { sent_reply_id: 'snd_now' }),
    record('c2', { sent_reply_id: 'snd_fin' }),
    record('c3', { sent_reply_id: 'snd_fin' }),
    record('r1', { re: 'c3', sent_reply_id: 'snd_reply' }),
  ];
  const sends = [
    send('snd_now', 2, { comments: ['c1'] }),
    send('snd_fin', 3, { mode: 'round', comments: ['c2', 'c3', 'c1'] }),
    send('snd_reply', 4, { comments: ['r1'] }),
  ];
  const live = inboxLiveCommentThreads(sends, records);

  test('a thread is live once a `now` send carried it or a reply under it; a Finish makes none live', () => {
    expect([...live].sort()).toEqual(['c1', 'c3']);
  });

  test("the person's next reply under a live thread goes on its own; a sub-thread, a sent reply or a reply elsewhere does not", () => {
    expect(inboxCommentDraftIsLive(record('d1', { re: 'c1' }), live)).toBe(true);
    expect(inboxCommentDraftIsLive(record('d2', { re: 'c2' }), live)).toBe(false);
    expect(inboxCommentDraftIsLive(record('d3', { parent: 'c1', quote_offset: 0 }), live)).toBe(false);
    expect(inboxCommentDraftIsLive(record('d4', { re: 'c1', sent_reply_id: 'snd_x' }), live)).toBe(false);
    expect(inboxCommentDraftIsLive(record('d5', { re: 'c1', removed_at: at(9) }), live)).toBe(false);
  });
});

describe('the status of what a send carried', () => {
  const delivered = { state: 'delivered' as const, host: 'claude-code', session: 'ses_a', at: at(3) };

  test('pending, delivered, read, working while its session is in a turn, replied once an agent answered after it', () => {
    const base = send('snd_1', 2);
    expect(inboxCommentSendStatus(base, null, false)).toBe('pending');
    // A busy session that has not taken it yet is not working on it.
    expect(inboxCommentSendStatus(base, null, true)).toBe('pending');
    expect(inboxCommentSendStatus({ ...base, delivery: delivered }, null, false)).toBe('delivered');
    expect(inboxCommentSendStatus({ ...base, read_at: at(4) }, null, false)).toBe('read');
    expect(inboxCommentSendStatus({ ...base, delivery: delivered, read_at: at(4) }, null, false)).toBe('read');
    expect(inboxCommentSendStatus({ ...base, delivery: delivered }, null, true)).toBe('working');
    expect(inboxCommentSendStatus({ ...base, delivery: delivered }, at(5), true)).toBe('replied');
    // A reply from before the send reached its session answered something else, even one after the send was made.
    expect(inboxCommentSendStatus({ ...base, delivery: delivered }, at(1), false)).toBe('delivered');
    expect(inboxCommentSendStatus(base, at(5), false)).toBe('pending');
    expect(inboxCommentSendStatus({ ...base, delivery: { ...delivered, at: at(6) } }, at(5), false)).toBe('delivered');
  });
});

describe('the text a send gives the agent', () => {
  const answer = agentReply('rep_a', 'c1', 4);
  const c1 = record('c1', { sent_reply_id: 'snd_0', created_at: at(1) });

  test('a `now` send: the round still open, one entry with its id, place, quote and words', () => {
    const c2 = record('c2', { sent_reply_id: 'snd_1', annotation: { id: 'c2', type: 'COMMENT', originalText: 'every\nstore', text: 'One store first.\nThen the rest.' } });
    const text = inboxCommentSendText({ sends: [send('snd_1', 5, { round: 3, comments: ['c2'] })], records: [c1, c2], root: '/repo' });
    expect(headings(text)).toEqual(['### 1. Comment on message msg_a1: "every store" (id c2)']);
    expect(text).toContain('> One store first.\n> Then the rest.');
    // Deliberate words for the agent: it must know the round goes on.
    expect(text).toContain('Round 3 is still open');
    expect(text).not.toContain('c1');
  });

  test('a Finish: every draft it carried, then the threads still open by id and count, their words not repeated', () => {
    const reply = record('r1', { re: 'c1', sent_reply_id: 'snd_2', created_at: at(6), annotation: { id: 'r1', type: 'COMMENT', originalText: 'words of c1', text: 'not yet' } });
    const sub = record('s1', {
      parent: 'rep_a',
      quote_offset: 0,
      sent_reply_id: 'snd_2',
      created_at: at(7),
      annotation: { id: 's1', type: 'COMMENT', originalText: 'answer', text: 'which one?' },
    });
    const onFile = record('f1', {
      sent_reply_id: 'snd_2',
      created_at: at(8),
      message: undefined,
      attachment_id: 'att_1',
      path: '/repo/notes.md',
      annotation: { id: 'f1', type: 'DELETION', originalText: 'Ship on Friday.', text: '' },
    });
    const open = record('c9', { sent_reply_id: 'snd_0', annotation: { id: 'c9', type: 'COMMENT', originalText: 'old words', text: 'an old comment' } });
    const finish = send('snd_2', 9, { mode: 'round', round: 2, comments: ['r1', 's1', 'f1', 'c1', 'c9'] });
    const text = inboxCommentSendText({ sends: [finish], records: [c1, open, reply, sub, onFile], agentReplies: [answer], root: '/repo' });
    expect(headings(text)).toEqual([
      '### 1. Reply under comment c1, on message msg_a1: "words of c1" (id r1)',
      '### 2. Comment on a passage of reply rep_a under comment c1 (on message msg_a1): "answer" (id s1)',
      '### 3. Remove this, on notes.md: "Ship on Friday." (id f1)',
    ]);
    expect(text).toContain(`In: "${answer.text}"`);
    expect(text).toContain('finished round 2');
    const openLine = text.split('\n').find((line) => line.includes('c9'))!;
    expect(openLine).toContain('(2)');
    expect(openLine).toContain('c1, c9');
    expect(text).not.toContain('an old comment');
  });

  test('a Finish with no draft names the open threads alone; with none open either, it still ends the round', () => {
    const named = inboxCommentSendText({ sends: [send('snd_2', 9, { mode: 'round', round: 2, comments: ['c1'] })], records: [c1], root: '/repo' });
    expect(headings(named)).toEqual([]);
    expect(named).toContain('(1): c1');
    const empty = inboxCommentSendText({ sends: [send('snd_2', 9, { mode: 'round', round: 2 })], records: [c1], root: '/repo' });
    expect(headings(empty)).toEqual([]);
    expect(empty).toContain('finished round 2');
    expect(empty).not.toContain('c1');
  });

  test('a long list of open threads names the newest and counts the rest', () => {
    const ids = Array.from({ length: INBOX_OPEN_COMMENTS_SENT + 2 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const text = inboxCommentSendText({ sends: [send('snd_2', 9, { mode: 'round', round: 2, comments: ids })], records: [], root: '/repo' });
    expect(text).toContain(`(${ids.length})`);
    expect(text).not.toContain('c00,');
    expect(text).toContain(`${ids.at(-1)}`);
    expect(text).toContain('2 older');
  });

  test("a mixed send: the person's words first, then the section", () => {
    const c2 = record('c2', { sent_reply_id: 'snd_1' });
    const text = inboxCommentSendText({ sends: [send('snd_1', 5, { comments: ['c2'], with_message: 'msg_p9' })], records: [c2], root: '/repo', words: '  Looks closer. One more thing:  ' });
    expect(text.startsWith('Looks closer. One more thing:\n\n# ')).toBe(true);
    expect(headings(text)).toHaveLength(1);
  });

  test('sends one delivery takes together: every entry once, the finished round and the one still open', () => {
    const c2 = record('c2', { sent_reply_id: 'snd_1', created_at: at(5) });
    const c3 = record('c3', { sent_reply_id: 'snd_3', created_at: at(7) });
    const sends = [send('snd_3', 7, { round: 4, comments: ['c3'] }), send('snd_1', 5, { round: 3, comments: ['c2'] }), send('snd_2', 6, { mode: 'round', round: 3, comments: ['c2', 'c1'] })];
    const text = inboxCommentSendText({ sends, records: [c1, c2, c3], root: '/repo' });
    expect(headings(text).map((line) => /\(id (\w+)\)$/.exec(line)![1])).toEqual(['c2', 'c3']);
    expect(text).toContain('finished round 3');
    expect(text).toContain('Round 4 is still open');
    expect(text).toContain('(1): c1');
  });
});

describe('the thread view', () => {
  const messages = [agent('msg_a1', 0)];
  const c1 = record('c1', { sent_reply_id: 'snd_1', created_at: at(1) });
  const legacy = record('c0', { sent_reply_id: 'msg_p0', created_at: at(0) });
  const rep = agentReply('rep_a', 'c1', 4);
  const r1 = record('r1', { re: 'c1', sent_reply_id: 'snd_2', created_at: at(6), annotation: { id: 'r1', type: 'COMMENT', originalText: 'words of c1', text: 'and?' } });
  const onReply = record('s1', { parent: 'rep_a', quote_offset: 7, sent_reply_id: 'snd_2', created_at: at(7), annotation: { id: 's1', type: 'COMMENT', originalText: 'rep_a', text: 'this' } });
  const onComment = record('s2', { parent: 'c1', quote_offset: 0, sent_reply_id: 'snd_2', created_at: at(8), annotation: { id: 's2', type: 'COMMENT', originalText: 'comment', text: 'that' } });
  const onSub = record('s3', { parent: 's1', quote_offset: 0, sent_reply_id: 'snd_2', created_at: at(9), annotation: { id: 's3', type: 'COMMENT', originalText: 'this', text: 'deeper' } });
  const sends = [
    send('snd_1', 2, { comments: ['c1'], delivery: { state: 'delivered', host: 'claude-code', session: 'ses_a', at: at(3) } }),
    send('snd_2', 10, { mode: 'round', comments: ['r1', 's1', 's2', 's3', 'c1'] }),
  ];

  test('a tree: replies under their thread, each sub-thread under the message it is on, at any depth, with statuses and the round', () => {
    const view = inboxCommentThreadView({ messages: [person('msg_p0', 0), ...messages], records: [legacy, c1, r1, onReply, onComment, onSub], agentReplies: [rep], sends });
    expect(view.v).toBe(INBOX_COMMENT_THREAD_VIEW_VERSION);
    expect(view.round).toBe(3);
    expect(view.threads.map((t) => t.id)).toEqual(['c0', 'c1']);
    const [old, thread] = view.threads;
    // Carried by the person's reply, before sends: no status.
    expect(old!.status).toBeUndefined();
    expect(thread).toMatchObject({ id: 'c1', round: 2, state: 'open', status: 'replied', live: true });
    expect(thread!.replies.map((r) => [r.id, r.author.kind, r.status ?? null])).toEqual([
      ['rep_a', 'agent', null],
      ['r1', 'person', 'pending'],
    ]);
    expect(thread!.sub_threads.map((t) => t.id)).toEqual(['s2']);
    const [onAnswer] = thread!.replies[0]!.sub_threads;
    expect(onAnswer).toMatchObject({ id: 's1', parent: { id: 'rep_a', quote_offset: 7 }, status: 'pending', live: false });
    expect(onAnswer!.sub_threads.map((t) => t.id)).toEqual(['s3']);
  });

  test("the person's drafts are listed with what was sent, in the round under way, and a draft reply opens a resolved comment", () => {
    const resolved = { ...c1, resolved_at: at(5) };
    const draftReply = record('d1', { re: 'c1', created_at: at(12), annotation: { id: 'd1', type: 'COMMENT', originalText: 'words of c1', text: 'one more thing' } });
    const draftComment = record('d2', { created_at: at(13) });
    const view = inboxCommentThreadView({ messages, records: [resolved, draftReply, draftComment], agentReplies: [rep], sends: [sends[0]!] });
    expect(view.threads.map((t) => [t.id, t.draft, t.round, t.reply_id])).toEqual([
      ['c1', false, 1, 'snd_1'],
      ['d2', true, 1, ''],
    ]);
    const [thread, draft] = view.threads;
    expect(thread).toMatchObject({ state: 'open', folded: false });
    expect(thread!.replies.map((r) => [r.id, r.draft, r.status ?? null])).toEqual([
      ['rep_a', false, null],
      ['d1', true, null],
    ]);
    expect(draft!.status).toBeUndefined();
    // In the round under way, what was sent comes before the drafts; a guided review's draft is not listed.
    const later = record('c5', { sent_reply_id: 'snd_9', created_at: at(20) });
    const guideDraft = record('g9', { message: undefined, guide: { title: 'Review', file: 'a.ts', side: 'new', line_start: 1, line_end: 1 }, version: 'a'.repeat(64) });
    const mixed = inboxCommentThreadView({ messages, records: [resolved, draftComment, later, guideDraft], sends: [sends[0]!, send('snd_9', 19, { comments: ['c5'] })] });
    expect(mixed.threads.map((t) => t.id)).toEqual(['c1', 'c5', 'd2']);
    // What an agent reads (drafts left out): the comment stays resolved.
    expect(inboxCommentThreadView({ messages, records: [resolved], agentReplies: [rep], sends: [sends[0]!] }).threads[0]).toMatchObject({ state: 'resolved', folded: true });
  });

  test('a resolved thread folds only once nothing under it is open, a draft sub-thread included', () => {
    const resolved = { ...c1, resolved_at: at(5) };
    const sub = record('s5', { parent: 'rep_a', quote_offset: 0, sent_reply_id: 'snd_1', created_at: at(2), annotation: { id: 's5', type: 'COMMENT', originalText: 'answer', text: 'hm' } });
    const view = (records: InboxAnnotationRecord[]) => inboxCommentThreadView({ messages, records, agentReplies: [rep], sends: [sends[0]!] }).threads;
    expect(view([resolved, sub])[0]).toMatchObject({ id: 'c1', state: 'resolved', folded: false });
    const both = view([resolved, { ...sub, resolved_at: at(6) }])[0]!;
    expect(both).toMatchObject({ folded: true });
    expect(both.replies[0]!.sub_threads[0]).toMatchObject({ id: 's5', folded: true });
    const pending = record('s6', { parent: 'c1', quote_offset: 0, created_at: at(12), annotation: { id: 's6', type: 'COMMENT', originalText: 'comment', text: 'wait' } });
    expect(view([resolved, { ...sub, resolved_at: at(6) }, pending])[0]).toMatchObject({ folded: false });
  });

  test("a reply names its author as people read it; the person's is left to the client, and no reply nests under another", () => {
    const view = inboxCommentThreadView({ messages, records: [c1, r1], agentReplies: [rep], sends });
    expect(view.threads[0]!.replies.map((r) => [r.id, r.author_name])).toEqual([
      ['rep_a', 'Claude Code'],
      ['r1', null],
    ]);
    expect(view.threads[0]!.replies.every((r) => r.replies === undefined)).toBe(true);
  });

  test('working while the session it reached is in a turn', () => {
    const view = inboxCommentThreadView({ messages, records: [c1], sends: [sends[0]!], busy: (session) => session === 'ses_a' });
    expect(view.threads[0]!.status).toBe('working');
  });

  test('a sub-thread whose message is gone, or that a broken writer left in a loop, sits at the top', () => {
    const orphan = record('s8', { parent: 'rep_gone', quote_offset: 0, sent_reply_id: 'snd_1' });
    const loopA = record('x', { parent: 'y', quote_offset: 0, sent_reply_id: 'snd_1' });
    const loopB = record('y', { parent: 'x', quote_offset: 0, sent_reply_id: 'snd_1' });
    const view = inboxCommentThreadView({ messages, records: [c1, orphan, loopA, loopB], sends: [sends[0]!] });
    expect(view.threads.map((t) => t.id).sort()).toEqual(['c1', 's8', 'x', 'y']);
  });
});

describe('the stored record', () => {
  test('a line reads as a comment send only when it is one: a reader skips a malformed or newer one', () => {
    const good = send(inboxCommentSendId(0), 1, { comments: ['c1'], tags: [], delivery: { state: 'delivered', host: 'claude-code', session: 'ses_a', at: at(2) }, read_at: null });
    expect(isInboxCommentSendRecord(good)).toBe(true);
    for (const bad of [
      { ...good, id: 'snd_1' },
      { ...good, mode: 'later' },
      { ...good, round: 0 },
      { ...good, to: { host: null } },
      { ...good, comments: [3] },
      { ...good, with_message: undefined },
      { ...good, delivery: { state: 'delivered' } },
      null,
    ]) {
      expect(isInboxCommentSendRecord(bad)).toBe(false);
    }
  });

  test("a send carries a draft, never a sent or removed comment, nor a guided review's", () => {
    expect(isInboxCommentSendable(record('d1'))).toBe(true);
    expect(isInboxCommentSendable(record('d2', { sent_reply_id: 'snd_1' }))).toBe(false);
    expect(isInboxCommentSendable(record('d3', { removed_at: at(2) }))).toBe(false);
    expect(isInboxCommentSendable(record('d4', { guide: { title: 'Review', file: 'a.ts', side: 'new', line_start: 1, line_end: 1 } }))).toBe(false);
  });
});

describe('where a press goes', () => {
  const by = (session: string, host = 'claude-code') => ({ kind: 'agent', host, session });
  const handoff = (id: string, session: string, undone = false): InboxCommentSendMessage => ({
    id,
    author: { kind: 'person' },
    to: { host: 'pi', session },
    handoff: { undone_at: undone ? at(9) : null },
  });

  test("the words answer the newest agent message, or after a hand-off the new owner's (the hand-off itself until it writes); never the former owner", () => {
    const opening: InboxCommentSendMessage = { id: 'm1', author: by('ses_a') };
    const later: InboxCommentSendMessage = { id: 'm2', author: by('ses_a') };
    expect(inboxWordsMessage([opening, later])?.id).toBe('m2');
    expect(inboxWordsMessage([opening, handoff('h1', 'ses_b'), { id: 'm3', author: by('ses_a') }])?.id).toBe('h1');
    expect(inboxWordsMessage([opening, handoff('h1', 'ses_b'), { id: 'm4', author: by('ses_b', 'pi') }, { id: 'm5', author: by('ses_a') }])?.id).toBe('m4');
    expect(inboxWordsMessage([opening, handoff('h1', 'ses_b', true), { id: 'm6', author: by('ses_a') }])?.id).toBe('m6');
    const started: InboxCommentSendMessage = { id: 'p1', author: { kind: 'person' }, to: { host: 'pi', session: 'ses_c' } };
    expect(inboxWordsMessage([started])?.id).toBe('p1');
    expect([inboxCommentSendAddress(started), inboxCommentSendAddress({ id: 'm7', author: { kind: 'agent', session: null } })]).toEqual([{ host: 'pi', session: 'ses_c' }, null]);
  });

  test("a comment on an agent's message goes to that message's session; a file's or a guided review's to the words' session, whose group is last", () => {
    const messages = new Map<string, InboxCommentSendMessage>([
      ['m1', { id: 'm1', author: by('ses_a') }],
      ['m2', { id: 'm2', author: by('ses_b', 'pi') }],
      ['m3', { id: 'm3', author: { kind: 'agent', session: null } }],
    ]);
    const words = { host: 'pi', session: 'ses_b' };
    const drafts = [
      record('file', { message: undefined, message_id: 'm1', attachment_id: 'att_1' }),
      record('on-a', { message_id: 'm1' }),
      record('reply-on-a', { message_id: 'm1', re: 'sent-on-a' }),
      record('on-b', { message_id: 'm2' }),
      record('no-session', { message_id: 'm3' }),
    ];
    const groups = inboxCommentSendRoutes(drafts, (id) => messages.get(id), words);
    expect(groups.map((g) => [g.to?.session, g.drafts.map((d) => d.id)])).toEqual([
      ['ses_a', ['on-a', 'reply-on-a']],
      ['ses_b', ['file', 'on-b', 'no-session']],
    ]);
    expect(inboxCommentSendRoutes([record('file', { message: undefined })], () => undefined, null)).toEqual([{ to: null, drafts: [expect.objectContaining({ id: 'file' })] }]);
  });
});

describe("the person's view while a Send is being read", () => {
  test('a comment whose carrier the reader has not read yet is in the round under way for the person, and left out for an agent', () => {
    const messages = [agent('msg_a1', 0)];
    const c1 = record('c1', { sent_reply_id: 'snd_1', created_at: at(1) });
    const fresh = record('r1', { re: 'c1', sent_reply_id: 'snd_new', created_at: at(3) });
    const sends = [send('snd_1', 2, { comments: ['c1'] })];
    const view = inboxCommentThreadView({ messages, records: [c1, fresh], sends });
    expect(view.threads[0]!.replies.map((r) => [r.id, r.round, r.draft])).toEqual([['r1', 1, false]]);
    expect(inboxCommentThreads(messages, [c1, fresh], [], sends)[0]!.replies).toEqual([]);
  });
});

describe('delivery: what the server adds to an entry, and the command field', () => {
  test("a document comment's lines: its words whole, or their first and last lines; none when the words are not there as written", () => {
    const text = '# Rollout\n\nStart with the Lyon store\nfor a week.\n\nThen all stores.\n';
    expect(inboxQuoteLines(text, 'Start with the Lyon store')).toEqual([3, 3]);
    expect(inboxQuoteLines(text, 'Lyon store\nfor a week.')).toEqual([3, 4]);
    expect(inboxQuoteLines(text, 'Start with the Lyon store\n\nThen all stores.')).toEqual([3, 6]);
    expect(inboxQuoteLines(text, 'the **Lyon** store')).toBeNull();
    expect(inboxQuoteLines(text, '   ')).toBeNull();
  });

  test('the notes: a diagram part, an HTML element, the images attached, the agents tagged', () => {
    const notes = inboxCommentEntryNotes(
      record('c1', {
        annotation: {
          type: 'COMMENT',
          text: 'Here.',
          diagramAnchor: { v: 1, kind: 'node', family: 'flowchart', id: 'D', label: 'Approve?', sourceLine: [4, 4] },
          elementContext: { tag: 'button', path: 'body > main > button#buy', name: 'Buy now' },
          images: [{ path: '/tmp/shot.png', name: 'shot' }],
          mentions: ['ses_pi'],
        },
      }),
      (sessions) => (sessions.includes('ses_pi') ? ['Pi'] : []),
    );
    expect(notes.some((line) => line.includes('Approve?'))).toBe(true);
    expect(notes).toContain('Element: body > main > button#buy "Buy now"');
    expect(notes).toContain('Images attached: /tmp/shot.png');
    expect(notes.some((line) => line.startsWith('Tagged Pi'))).toBe(true);
    // A plain comment adds nothing.
    expect(inboxCommentEntryNotes(record('c2'))).toEqual([]);
  });

  test("the text takes each entry's detail: lines in the heading's place, notes under it; none, and the entry is as before", () => {
    const carried = record('c1', { message: undefined, attachment_id: 'att_1', path: '/work/rollout.md', sent_reply_id: 'snd_1' });
    const sends = [send('snd_1', 2, { comments: ['c1'] })];
    const plain = inboxCommentSendText({ sends, records: [carried], root: '/work' });
    const detailed = inboxCommentSendText({ sends, records: [carried], root: '/work', detail: () => ({ lines: [3, 4], notes: ['Images attached: /tmp/a.png'] }) });
    expect(headings(plain)[0]).toContain('on rollout.md:');
    expect(headings(detailed)[0]).toContain('on rollout.md lines 3-4 when commented');
    const lines = detailed.split('\n');
    expect(lines[lines.indexOf(headings(detailed)[0]!) + 1]).toBe('Images attached: /tmp/a.png');
  });

  test('the command field: the sends in the order given, the newest one\'s round and mode, the comments they carry', () => {
    const sends = [send('snd_1', 2, { comments: ['c1'] }), send('snd_2', 3, { mode: 'round', round: 2, comments: ['c2', 'c0'] })];
    const records = [record('c1', { sent_reply_id: 'snd_1' }), record('c2', { sent_reply_id: 'snd_2' }), record('c0', { sent_reply_id: 'snd_0' }), record('c3', { sent_reply_id: 'snd_2', removed_at: at(4) })];
    expect(inboxCommentsWake(sends, records)).toEqual({ sends: ['snd_1', 'snd_2'], round: 2, mode: 'round', count: 2 });
  });
});
