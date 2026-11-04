import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import { attachmentFeedback, codeCommentAnnotation, codeRangeOf } from './attachments';
import { agentReplyAnnotation, commentOfCard, followCodeLines, sentReplyRounds, sentReplyRows, sentUnanchoredChanges, withSentWrites } from './sentComments';

const sent = (id: string, unanchored_at: string | null = null) => ({ id, unanchored_at, sent_reply_id: 'msg_p1' }) as unknown as InboxAnnotationRecord;

describe('what the window keeps of a sent comment it placed', () => {
  test('a change is sent only when what the window found differs from what is kept', () => {
    const records = [sent('lost'), sent('back', '2026-11-04T10:00:00.000Z'), sent('still', '2026-11-04T10:00:00.000Z'), sent('fine')];
    expect(sentUnanchoredChanges(records, { attempted: ['lost', 'back', 'still', 'fine'], unanchored: ['lost', 'still'] })).toEqual([
      { id: 'lost', unanchored: true },
      { id: 'back', unanchored: false },
    ]);
  });

  test('a comment the window did not try to place keeps its state (a first paint before the file was read)', () => {
    expect(sentUnanchoredChanges([sent('kept', '2026-11-04T10:00:00.000Z')], { attempted: [], unanchored: [] })).toEqual([]);
  });
});

describe('a sent code comment follows its lines', () => {
  const comment = codeCommentAnnotation({ id: 'c1', lineStart: 2, lineEnd: 3, text: 'why twice?', code: 'retry()\nretry()' });

  test('lines added above move it to where its lines are now', () => {
    const moved = followCodeLines(comment, ['// new', '// new', 'start()', 'retry()', 'retry()', 'end()']);
    expect(codeRangeOf(moved)).toMatchObject({ lineStart: 4, lineEnd: 5 });
    // The export and the panel read the lines from blockId.
    expect(moved.blockId).toBe('code-L4-5');
  });

  test('lines still in place, or gone, leave it as it is', () => {
    expect(followCodeLines(comment, ['start()', 'retry()', 'retry()'])).toBe(comment);
    expect(followCodeLines(comment, ['start()', 'retry()', 'done()'])).toBe(comment);
  });
});

describe("the person's Resolve or Reopen, before the files are read again", () => {
  const record = (id: string, updated_at: string, resolved_at: string | null = null) => ({ id, updated_at, resolved_at }) as unknown as InboxAnnotationRecord;

  test('drawn at once, and kept until a newer change (another window) comes in the listing', () => {
    const listed = [record('c1', '2026-11-04T10:00:00.000Z'), record('c2', '2026-11-04T10:00:00.000Z')];
    const mine = record('c1', '2026-11-04T10:05:00.000Z', '2026-11-04T10:05:00.000Z');
    const written = new Map([['c1', mine]]);
    expect(withSentWrites(listed, written).map((r) => r.resolved_at)).toEqual(['2026-11-04T10:05:00.000Z', null]);
    // The listing caught up: the same record.
    expect(withSentWrites([mine, listed[1]!], written)[0]).toBe(mine);
    // Another window reopened it later: that wins.
    const theirs = record('c1', '2026-11-04T10:07:00.000Z', null);
    expect(withSentWrites([theirs, listed[1]!], written)[0]).toBe(theirs);
  });
});

describe('replies under a sent comment, as the window draws them', () => {
  const comment = {
    id: 'c1',
    message_id: 'msg_a1',
    message: { at: '2026-11-04T10:00:00.000Z' },
    path: 'msg_a1',
    version: 'current',
    sent_reply_id: 'msg_p1',
    removed_at: null,
    created_at: '2026-11-04T10:00:30.000Z',
    annotation: { id: 'c1', type: 'COMMENT', blockId: 'b2', startOffset: 3, endOffset: 9, originalText: 'Friday', text: 'Not then.' },
  } as unknown as InboxAnnotationRecord;
  const mine = (id: string, sent_reply_id: string | null, created_at: string) =>
    ({ ...comment, id, re: 'c1', sent_reply_id, created_at, annotation: { id, text: `mine ${id}`, inReplyTo: 'c1', originalText: 'Friday' } }) as unknown as InboxAnnotationRecord;
  const agents: InboxCommentReplyRecord[] = [
    { id: 'rep_a', project_id: 'prj', thread_id: 'msg_a1', re: 'c1', from: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null }, message_id: 'msg_a2', text: 'Tuesday?', created_at: '2026-11-04T10:02:00.000Z' },
  ];
  const messages = [
    { id: 'msg_a1', author: { kind: 'agent' }, created_at: '2026-11-04T10:00:00.000Z' },
    { id: 'msg_p1', author: { kind: 'person' }, created_at: '2026-11-04T10:01:00.000Z' },
    { id: 'msg_a2', author: { kind: 'agent' }, created_at: '2026-11-04T10:03:00.000Z' },
    { id: 'msg_p2', author: { kind: 'person' }, created_at: '2026-11-04T10:05:00.000Z' },
  ];

  test("one list per comment, oldest first: the agent's by its name, the person's as You, a draft marked so, each with its round", () => {
    const sent = [comment, mine('r1', 'msg_p2', '2026-11-04T10:04:00.000Z')];
    const rounds = sentReplyRounds(messages, new Map([['msg_p1', 1], ['msg_p2', 2]]), sent, agents);
    const rows = sentReplyRows([...sent, mine('d1', null, '2026-11-04T10:06:00.000Z')], agents, rounds).get('c1')!;
    expect(rows.map((row) => [row.id, row.who, row.round, row.draft])).toEqual([
      ['rep_a', 'Claude Code', 1, false],
      ['r1', 'You', 2, false],
      ['d1', 'You', undefined, true],
    ]);
  });

  test("an agent's reply is a card in its comment's place, threaded under it, by the agent", () => {
    const card = agentReplyAnnotation(comment, agents[0]!);
    expect(card).toMatchObject({ id: 'rep_a', inReplyTo: 'c1', blockId: 'b2', startOffset: 3, originalText: 'Friday', text: 'Tuesday?', author: 'Claude Code', type: 'COMMENT' });
  });

  test("a Reply on a reply's card goes under that reply's comment", () => {
    const records = [comment, mine('r1', 'msg_p2', '2026-11-04T10:04:00.000Z')];
    expect(['c1', 'r1', 'rep_a'].map((id) => commentOfCard(id, records, agents))).toEqual(['c1', 'c1', 'c1']);
  });

  test("a Send carries the person's replies in a section of their own, each under its comment's id, and nowhere else", () => {
    const fresh = { ...comment, id: 'c2', sent_reply_id: null, annotation: { ...comment.annotation, id: 'c2', text: 'New point.' } } as InboxAnnotationRecord;
    const text = attachmentFeedback([fresh, mine('r1', null, '2026-11-04T10:04:00.000Z')], [], new Map(), '/repo');
    const [messagesPart, threadsPart] = text.split('# Feedback on comment threads');
    expect(messagesPart).toContain('(id c2)');
    expect(messagesPart).not.toContain('mine r1');
    expect(threadsPart).toContain('### 1. Reply under comment c1, on message msg_a1: "Friday" (id r1)');
    expect(threadsPart).toContain('> mine r1');
  });
});
