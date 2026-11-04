/**
 * The thread kept for the conversation (experimental "persistent-comments";
 * roundLines.ts): which of the person's Sends are their round's line alone,
 * which keep their message with the boxed feedback folded under it, and
 * what the line says they carried. Failures this catches: a Send with the
 * person's words, answers, a file or a guided review's comments drawn as a
 * bare line (what only the message shows would be hidden); a guided
 * review's comments folded away although no box draws them; a line that
 * counts wrong once the sections' writers change (the counts are read back
 * from their real output here).
 */
import { describe, expect, test } from 'bun:test';
import { inboxCommentRepliesFeedback, inboxCommentThreads, inboxOpenCommentsFeedback } from '@plannotator/core/inbox-comment-threads';
import { composeInboxReplyBody } from '@plannotator/core/inbox-questions';
import type { InboxAnnotationRecord, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentFeedback } from './attachments';
import { isRepliesOnly, isRoundAlone, repliedUnderWords, roundLineWords, sendRound, splitRoundFeedback } from './roundLines';

const AT = '2026-11-04T10:00:00.000Z';

function record(id: string, fields: Partial<InboxAnnotationRecord> = {}): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_A',
    message_id: 'msg_A',
    attachment_id: '',
    path: 'msg_A',
    version: 'current',
    message: { at: AT },
    annotation: { id, blockId: 'block-0', startOffset: 0, endOffset: 5, type: 'COMMENT', text: `on ${id}`, originalText: `words ${id}`, createdA: 1 },
    created_at: AT,
    updated_at: AT,
    removed_at: null,
    sent_reply_id: null,
    ...fields,
  };
}

/** A round-2 Send's feedback as the window and the store write it: two new comments, a reply, a sub-thread, then the open ones sent again. */
function roundTwoFeedback(): string {
  const sent = [record('c1', { sent_reply_id: 'msg_P1' }), record('c2', { sent_reply_id: 'msg_P1', created_at: '2026-11-04T10:00:01.000Z' })];
  const fresh = [
    record('n1'),
    record('n2', { created_at: '2026-11-04T10:00:02.000Z' }),
    record('r1', { re: 'c1', created_at: '2026-11-04T10:00:03.000Z' }),
    record('s1', { parent: 'c2', quote_offset: 0, created_at: '2026-11-04T10:00:04.000Z' }),
  ];
  const window = attachmentFeedback(fresh, [], new Map(), '/repo');
  const open = inboxOpenCommentsFeedback(inboxCommentThreads([{ id: 'msg_A', author: { kind: 'agent' }, created_at: AT }, { id: 'msg_P1', author: { kind: 'person' }, created_at: AT }], sent), '/repo');
  return [window, open].join('\n\n');
}

const GUIDE = '# Feedback on the guided review\n\nThe person reviewed your guided review "Retry".\n\n## src/retry.ts\n\n### Line 4 (new) (id g1)\nCap the wait.';

function person(body: string, fields: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return { id: 'msg_P2', project_id: 'prj_x', thread_id: 'msg_A', reply_to: 'msg_A', author: { kind: 'person' }, subject: null, body, created_at: AT, resolved_at: null, idempotency_key: 'k', ...fields };
}

describe("a Send's feedback, split for its line", () => {
  test('the sections the boxes hold go behind the line, counted from the text the agent got; a guided review stays', () => {
    const feedback = `${roundTwoFeedback()}\n\n${GUIDE}`;
    const split = splitRoundFeedback(feedback);
    expect(split.counts).toEqual({ comments: 2, replies: 1, subThreads: 1, open: 2 });
    expect(split.rest).toBe(GUIDE);
    expect(split.boxed).toContain('# Feedback on your messages');
    expect(split.boxed).toContain('# Feedback on comment threads');
    expect(split.boxed).toContain('# Feedback on comments still open');
    expect(split.boxed).not.toContain('guided review');
  });

  test('without a section the boxes hold there is no line', () => {
    expect(splitRoundFeedback(GUIDE).boxed).toBe('');
    expect(sendRound(person(GUIDE))).toBeNull();
    expect(sendRound(person('Looks good, ship it.'))).toBeNull();
  });
});

describe('which Send is its line alone', () => {
  const feedback = roundTwoFeedback();
  const none = { answers: 0, actions: 0 };

  test('only boxed feedback, with what the store writes for the agent around it, is the line alone', () => {
    const plain = sendRound(person(feedback))!;
    expect(plain.boxedOnly).toBe(true);
    expect(isRoundAlone(person(feedback), plain, none)).toBe(true);
    // The line on questions still open is the store's, for the agent: the Send is still the line alone.
    const stillOpen = composeInboxReplyBody({ questions: [], sent: [], earlier: [], messages: [], replyTo: 'msg_A', words: '', stillOpen: [{ id: 'q1', key: 'q-1', message_id: 'msg_A', position: 0, prompt: 'Which store first?', kind: 'single', answer: null, revision: 0, sent_revision: 0, sent_reply_id: null } as never] });
    expect(stillOpen).not.toBe('');
    expect(sendRound(person(`${stillOpen}\n\n${feedback}`))!.boxedOnly).toBe(true);
    // A skills block the window pasted after the feedback is for the agent too.
    expect(sendRound(person(`${feedback}\n\n**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):\n\n- /deploy`))!.boxedOnly).toBe(true);
  });

  test("the person's words, answers, action items, a file, a verdict or a guided review's comments keep the message", () => {
    expect(sendRound(person(`Lyon first, then the rest.\n\n${feedback}`))!.boxedOnly).toBe(false);
    expect(sendRound(person(`${feedback}\n\n${GUIDE}`))!.boxedOnly).toBe(false);
    const round = sendRound(person(feedback))!;
    expect(isRoundAlone(person(feedback), round, { answers: 1, actions: 0 })).toBe(false);
    expect(isRoundAlone(person(feedback), round, { answers: 0, actions: 1 })).toBe(false);
    expect(isRoundAlone(person(feedback, { attachments: [{ id: 'att_1' } as never] }), round, none)).toBe(false);
    expect(isRoundAlone(person(feedback, { review_verdict: { verdict: 'approve' } as never }), round, none)).toBe(false);
  });

  test("an agent's message, the Inbox's notes and a Re-ask are never a round's line", () => {
    expect(sendRound(person(feedback, { author: { kind: 'agent', host: 'claude-code', session: 's', name: null } }))).toBeNull();
    expect(sendRound(person(feedback, { reask: ['msg_A/q-1'] }))).toBeNull();
    expect(sendRound(person(feedback, { set_aside: ['msg_A/q-1'] }))).toBeNull();
  });
});

describe("the line's words", () => {
  // The owner's line (decision 2026-11-04 22:45:55, "Round 5 · 2 comments, 1 reply, 1 sub-thread sent · 4 open
  // threads"), pinned on purpose: what was sent, then the open threads sent again.
  test('the round, what was sent, then the open threads sent again; a part with nothing is left out', () => {
    expect(roundLineWords({ comments: 2, replies: 1, subThreads: 1, open: 4 }, 5)).toBe('Round 5 · 2 comments, 1 reply, 1 sub-thread sent · 4 open threads sent again');
    expect(roundLineWords({ comments: 0, replies: 2, subThreads: 0, open: 1 }, 3)).toBe('Round 3 · 2 replies sent · 1 open thread sent again');
    expect(roundLineWords({ comments: 0, replies: 0, subThreads: 0, open: 3 }, undefined)).toBe('3 open threads sent again');
  });

  test("an agent's message with no body is its replies' line", () => {
    const agent = person('', { author: { kind: 'agent', host: 'claude-code', session: 's', name: null } });
    expect(isRepliesOnly(agent)).toBe(true);
    expect(isRepliesOnly({ ...agent, body: 'Both changes are in.' })).toBe(false);
    expect(isRepliesOnly({ ...agent, guide: { id: 'g' } as never })).toBe(false);
    expect(repliedUnderWords(2)).toBe('Replied under 2 comments');
    expect(repliedUnderWords(1)).toBe('Replied under 1 comment');
  });
});

test('the open section and the replies section a real Send writes are read back whole', () => {
  // A reply and a sub-thread alone, as the person's second round may be.
  const text = inboxCommentRepliesFeedback([record('r1', { re: 'c1' }), record('s1', { parent: 'c1', quote_offset: 0, created_at: '2026-11-04T10:00:05.000Z' })], '/repo');
  expect(splitRoundFeedback(text).counts).toEqual({ comments: 0, replies: 1, subThreads: 1, open: 0 });
});
