import { describe, expect, test } from 'bun:test';
import {
  REVIEW_COMMENT_READING,
  REVIEW_THREAD_VIEW_VERSION,
  reviewAnchorPlace,
  reviewRoundNow,
  reviewRounds,
  reviewSendText,
  reviewThreads,
  reviewThreadView,
  reviewThreadViewText,
  type ReviewAgentReply,
  type ReviewComment,
  type ReviewSend,
} from './review-threads';

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`;

function comment(id: string, fields: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    on: { kind: 'file', path: '/repo/docs/plan.md', lines: [3, 4] },
    quote: `words of ${id}`,
    text: `comment ${id}`,
    created_at: at(1),
    updated_at: at(1),
    removed_at: null,
    sent_reply_id: null,
    ...fields,
  };
}

function send(id: string, minute: number, fields: Partial<ReviewSend> = {}): ReviewSend {
  return {
    id,
    batch: id,
    to: { host: 'claude-code', session: 'ses_a' },
    round: 1,
    mode: 'now',
    comments: [],
    words: null,
    idempotency_key: null,
    created_at: at(minute),
    ...fields,
  };
}

function agentReply(id: string, re: string, minute: number, fields: Partial<ReviewAgentReply> = {}): ReviewAgentReply {
  return { id, re, from: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null }, text: `answer ${id}`, created_at: at(minute), ...fields };
}

const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('### '));
const how = { read: 'plannotator threads --review k1 has their words and replies.', reply: 'Reply with: plannotator reply --review k1 <id>' };

describe('rounds of a review journal (sends only)', () => {
  test('a now send leaves the round open, a Finish ends it, and the sends of one press are one step', () => {
    const sends = [send('snd_1', 2), send('snd_2', 3, { mode: 'round' }), send('snd_3', 4, { mode: 'round', batch: 'snd_2' }), send('snd_4', 5)];
    expect([...reviewRounds([], sends)]).toEqual([['snd_1', 1], ['snd_2', 1], ['snd_3', 1], ['snd_4', 2]]);
    expect(reviewRoundNow([], sends)).toBe(2);
    expect(reviewRoundNow([], [...sends, send('snd_5', 6, { mode: 'round' })])).toBe(3);
    expect(reviewRoundNow([])).toBe(1);
  });

  test("an agent's reply is in the round of the newest send its session had received, never one still waiting", () => {
    const records = [comment('c1', { sent_reply_id: 'snd_1' }), comment('c2', { sent_reply_id: 'snd_2', created_at: at(3) })];
    const sends = [send('snd_1', 2, { mode: 'round', delivery: { at: at(2) } }), send('snd_2', 4)];
    const threads = reviewThreads(REVIEW_COMMENT_READING, records, [agentReply('rep_1', 'c1', 5), agentReply('rep_2', 'c2', 6, { from: { kind: 'agent', host: 'pi', session: 'ses_b', name: null } })], sends);
    expect(threads.map((thread) => [thread.id, thread.round, thread.replies.map((reply) => reply.round)])).toEqual([
      ['c1', 1, [1]],
      ['c2', 2, [1]],
    ]);
  });
});

describe('the thread model on journal records', () => {
  test("drafts are listed only when asked, after what was sent; a reply's or sub-thread's place is its thread's", () => {
    const records = [
      comment('c1', { sent_reply_id: 'snd_1' }),
      comment('r1', { re: 'c1', created_at: at(3) }),
      comment('s1', { parent: 'c1', quote: 'of c1', quote_offset: 6, created_at: at(4) }),
      comment('c2', { created_at: at(2) }),
    ];
    const sends = [send('snd_1', 2)];
    expect(reviewThreads(REVIEW_COMMENT_READING, records, [], sends).map((thread) => thread.id)).toEqual(['c1']);
    const mine = reviewThreads(REVIEW_COMMENT_READING, records, [], sends, { drafts: true });
    expect(mine.map((thread) => [thread.id, thread.draft === true])).toEqual([
      ['c1', false],
      ['c2', true],
      ['s1', true],
    ]);
    expect(mine[0]!.replies.map((reply) => [reply.id, reply.draft === true])).toEqual([['r1', true]]);
  });

  test('a reply newer than the resolution opens a resolved comment again', () => {
    const records = [comment('c1', { sent_reply_id: 'snd_1', resolved_at: at(4) })];
    const sends = [send('snd_1', 2, { delivery: { at: at(2) } })];
    expect(reviewThreads(REVIEW_COMMENT_READING, records, [], sends)[0]!.state).toBe('resolved');
    expect(reviewThreads(REVIEW_COMMENT_READING, records, [agentReply('rep_1', 'c1', 5)], sends)[0]!.state).toBe('open');
  });
});

describe('where a journal comment is, for the agent', () => {
  test('a message, a file from the root, the plan with its version, and lines when known', () => {
    expect(reviewAnchorPlace({ kind: 'message', message_id: 'msg_1' }, '/repo')).toBe('on your message msg_1');
    expect(reviewAnchorPlace({ kind: 'message', message_id: '' }, '/repo')).toBe('on your message');
    expect(reviewAnchorPlace({ kind: 'file', path: '/repo/docs/plan.md', lines: [3, 4] }, '/repo')).toBe('on docs/plan.md lines 3-4 when commented');
    expect(reviewAnchorPlace({ kind: 'file', path: '/elsewhere/a.md' }, '/repo')).toBe('on /elsewhere/a.md');
    expect(reviewAnchorPlace({ kind: 'plan', version: 2, lines: [5, 5] }, '/repo')).toBe('on the plan (version 2) line 5 when commented');
  });
});

describe('the text a send gives the agent', () => {
  test('a Finish lists what it carried, names the threads still open with the read sentence, and ends with how to reply', () => {
    const records = [
      comment('c1', { sent_reply_id: 'snd_1' }),
      comment('c2', { sent_reply_id: 'snd_2', created_at: at(3), type: 'deletion', on: { kind: 'plan', version: 1 } }),
      comment('r1', { re: 'c1', sent_reply_id: 'snd_2', created_at: at(4) }),
      comment('s1', { parent: 'rep_1', quote: 'two stores', quote_offset: 0, sent_reply_id: 'snd_2', created_at: at(5) }),
    ];
    const replies = [agentReply('rep_1', 'c1', 2, { text: 'two stores now' })];
    const text = reviewSendText(REVIEW_COMMENT_READING, {
      sends: [send('snd_2', 6, { mode: 'round', comments: ['c2', 'r1', 's1', 'c1'] })],
      records,
      agentReplies: replies,
      root: '/repo',
      words: 'Looks closer.',
      how,
    });
    expect(text.startsWith('Looks closer.\n\n# Comments on your work')).toBe(true);
    expect(headings(text)).toEqual([
      '### 1. Remove this, on the plan (version 1): "words of c2" (id c2)',
      '### 2. Reply under comment c1, on docs/plan.md lines 3-4 when commented: "words of r1" (id r1)',
      '### 3. Comment on a passage of reply rep_1 under comment c1 (on docs/plan.md lines 3-4 when commented): "two stores" (id s1)',
    ]);
    expect(text).toContain('In: "two stores now"');
    const paragraphs = text.split('\n\n');
    expect(paragraphs.at(-2)).toBe(`Still open, already sent to you (1): c1. ${how.read}`);
    expect(paragraphs.at(-1)).toBe(how.reply);
  });

  test('a Finish with nothing open asks for no reply; a caller adds lines to an entry with no lines', () => {
    const nothing = reviewSendText(REVIEW_COMMENT_READING, { sends: [send('snd_1', 2, { mode: 'round' })], records: [], root: '/repo', how });
    expect(nothing).not.toContain(how.reply);
    expect(nothing).toContain('No comment is open.');
    const records = [comment('c1', { sent_reply_id: 'snd_1', on: { kind: 'file', path: '/repo/a.md' } })];
    const text = reviewSendText(REVIEW_COMMENT_READING, {
      sends: [send('snd_1', 2)],
      records,
      root: '/repo',
      how: { read: how.read },
      detail: () => ({ lines: [7, 8], notes: ['Images attached: /tmp/a.png'] }),
    });
    expect(headings(text)).toEqual(['### 1. Comment on a.md lines 7-8 when commented: "words of c1" (id c1)']);
    expect(text).toContain('Images attached: /tmp/a.png\n> comment c1');
    expect(text).toContain('Round 1 is still open');
  });
});

describe('the thread view of a journal', () => {
  test('statuses, live threads, folds, sub-threads under the reply they are on, and agent names', () => {
    const records = [
      // Live is the person's choice (`live_at`): the `now` send that carried c1 and c2 makes neither live.
      comment('c1', { sent_reply_id: 'snd_1', live_at: at(8) }),
      comment('c2', { sent_reply_id: 'snd_1', created_at: at(2), resolved_at: at(9) }),
      comment('s1', { parent: 'rep_1', quote: 'answer', quote_offset: 0, sent_reply_id: 'snd_2', created_at: at(6) }),
    ];
    const sends = [send('snd_1', 3, { comments: ['c1', 'c2'], delivery: { at: at(3) } }), send('snd_2', 7, { mode: 'round', comments: ['s1'] })];
    const view = reviewThreadView(REVIEW_COMMENT_READING, {
      records,
      agentReplies: [agentReply('rep_1', 'c1', 4), agentReply('rep_2', 'c2', 5, { from: { kind: 'agent', host: 'pi', session: 'ses_a', name: null } })],
      sends,
    });
    expect(view.v).toBe(REVIEW_THREAD_VIEW_VERSION);
    expect(view.round).toBe(2);
    const [c1, c2] = view.threads;
    expect([c1!.id, c1!.status, c1!.live, c1!.folded]).toEqual(['c1', 'replied', true, false]);
    expect([c2!.id, c2!.state, c2!.live, c2!.folded]).toEqual(['c2', 'resolved', false, true]);
    expect(c1!.replies[0]!.author_name).toBe('claude-code');
    expect(c1!.replies[0]!.sub_threads.map((sub) => [sub.id, sub.status])).toEqual([['s1', 'pending']]);
    expect(c2!.replies[0]!.author_name).toBe('pi');
    const named = reviewThreadView(REVIEW_COMMENT_READING, { records, agentReplies: [agentReply('rep_1', 'c1', 4)], sends, agentName: () => 'Claude Code' });
    expect(named.threads[0]!.replies[0]!.author_name).toBe('Claude Code');
  });

  test('as text: each thread by id with its state and place, replies and sub-threads indented, a folded one on one line', () => {
    const records = [comment('c1', { sent_reply_id: 'snd_1' }), comment('c2', { sent_reply_id: 'snd_1', created_at: at(2), resolved_at: at(9) }), comment('d1', { created_at: at(3), on: { kind: 'message', message_id: 'm1' } })];
    const view = reviewThreadView(REVIEW_COMMENT_READING, { records, agentReplies: [agentReply('rep_1', 'c1', 4)], sends: [send('snd_1', 3, { comments: ['c1', 'c2'] })] });
    const lines = reviewThreadViewText(view, reviewAnchorPlace, '/repo').split('\n');
    expect(lines[0]).toBe('Round 1');
    expect(lines.filter((line) => line.startsWith('- ')).map((line) => line.split(' ').slice(0, 3).join(' '))).toEqual(['- c1 (open,', '- c2 (resolved,', '- d1 (draft,']);
    expect(lines).toContain('  - reply rep_1 (round 1) claude-code: "answer rep_1"');
    expect(lines.some((line) => line.includes('"comment c2"'))).toBe(false);
    expect(lines.find((line) => line.startsWith('- d1'))).toContain('on your message m1');
  });
});
