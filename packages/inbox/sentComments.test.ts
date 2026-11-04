import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxCommentReplyRecord } from '@plannotator/core/inbox-types';
import { attachmentFeedback, codeCommentAnnotation, codeRangeOf } from './attachments';
import { inboxCommentMessages } from '@plannotator/core/inbox-comment-threads';
import {
  agentReplyAnnotation,
  commentOfCard,
  followCodeLines,
  hiddenUnderFolded,
  messagesWithOpenThreads,
  openPassagesByParent,
  placeThreads,
  sentReplyRounds,
  sentReplyRows,
  sentUnanchoredChanges,
  sitsUnder,
  subThreadsByParent,
  unfoldOpenThreads,
  withSentWrites,
} from './sentComments';

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

describe('sub-threads in the window', () => {
  const at = (n: number) => `2026-11-04T10:0${n}:00.000Z`;
  const rec = (id: string, fields: Partial<InboxAnnotationRecord>) =>
    ({ id, removed_at: null, sent_reply_id: 'msg_p1', created_at: at(1), annotation: { id, originalText: 'q', text: `words of ${id}` }, ...fields }) as InboxAnnotationRecord;
  const answer = { id: 'rep_a', re: 'c1', text: 'Step 2 rolls back through the off switch.', from: { kind: 'agent', host: null, session: 'ses_a', name: 'Claude Code' }, created_at: at(2) } as InboxCommentReplyRecord;
  const s1 = rec('s1', { parent: 'rep_a', quote_offset: 33, created_at: at(3), annotation: { id: 's1', originalText: 'off switch', text: 'Which off switch?' } });
  const s2 = rec('s2', { parent: 'rep_a', quote_offset: 7, created_at: at(4), sent_reply_id: null, annotation: { id: 's2', originalText: 'rolls back', text: 'How fast?' } });
  const nested = rec('s3', { parent: 's1', quote_offset: 6, created_at: at(5), annotation: { id: 's3', originalText: 'off switch', text: 'The runbook one.' } });

  test('each message lists its sub-threads, oldest first, drafts too; a removed one is gone', () => {
    const by = subThreadsByParent([nested, s2, s1, rec('gone', { parent: 'rep_a', removed_at: at(6) }), rec('c1', {})]);
    expect([...by].map(([parent, list]) => [parent, list.map((r) => r.id)])).toEqual([
      ['s1', ['s3']],
      ['rep_a', ['s1', 's2']],
    ]);
  });

  test("a message's words mark its sub-threads still open, not a resolved one", () => {
    const marks = openPassagesByParent(subThreadsByParent([s1, s2, nested]), new Set(['s1']));
    expect(marks.get('rep_a')).toEqual([{ quote: 'rolls back', offset: 7 }]);
    expect(marks.get('s1')).toEqual([{ quote: 'off switch', offset: 6 }]);
  });

  test('a folded thread hides what is under it, at any depth; nothing else is hidden', () => {
    const up = sitsUnder([rec('c1', {}), s1, nested], [answer]);
    expect(Object.fromEntries(up)).toEqual({ s1: 'rep_a', s3: 's1', rep_a: 'c1' });
    expect([...hiddenUnderFolded(['rep_a', 's1', 's3'], up, new Set(['c1']))].sort()).toEqual(['rep_a', 's1', 's3']);
    expect([...hiddenUnderFolded(['rep_a', 's1', 's3'], up, new Set(['s1']))]).toEqual(['s3']);
    expect(hiddenUnderFolded(['rep_a', 's1', 's3'], up, new Set()).size).toBe(0);
  });

  test("a Send carries a sub-thread in the threads' section, with the words its passage is in, and nowhere else", () => {
    const draft = { ...s1, sent_reply_id: null, message: { at: at(0) }, message_id: 'msg_a1', path: 'msg_a1' } as InboxAnnotationRecord;
    const text = attachmentFeedback([draft], [], new Map(), '/repo', { commentMessages: inboxCommentMessages([], [answer]) });
    expect(text.startsWith('# Feedback on comment threads')).toBe(true);
    expect(text).toContain('### 1. Comment on a passage of reply rep_a under comment c1 (on message msg_a1): "off switch" (id s1)\nIn: "Step 2 rolls back through the off switch."\n> Which off switch?');
    expect(text).not.toContain('# Feedback on your messages');
  });
});

describe('where the threads on a document are drawn', () => {
  const on = (id: string, blockId: unknown, unanchored_at: string | null = null) => ({ id, unanchored_at, annotation: { blockId } }) as unknown as InboxAnnotationRecord;
  const blocks = new Set(['block-0', 'block-1', 'block-2']);

  test('each under the block its passage starts in, several on one block in order', () => {
    const { byBlock, rest } = placeThreads([on('a', 'block-1'), on('b', 'block-0'), on('c', 'block-1')], blocks);
    expect([...byBlock].map(([block, list]) => [block, list.map((r) => r.id)])).toEqual([
      ['block-1', ['a', 'c']],
      ['block-0', ['b']],
    ]);
    expect(rest).toEqual([]);
  });

  test('at the end: a block not drawn, no block, or words not found', () => {
    const { byBlock, rest } = placeThreads([on('gone', 'block-9'), on('none', undefined), on('lost', 'block-1', '2026-11-04T10:00:00.000Z')], blocks);
    expect(byBlock.size).toBe(0);
    expect(rest.map((r) => r.id)).toEqual(['gone', 'none', 'lost']);
  });

  test("where the viewer found the words since wins over the stored block, and the viewer's own unanchored over the kept mark", () => {
    const { byBlock, rest } = placeThreads([on('moved', 'block-0'), on('found', 'block-2', '2026-11-04T10:00:00.000Z')], blocks, {
      moved: new Map([['moved', 'block-2']]),
      unanchored: new Set(),
    });
    expect([...byBlock].map(([block, list]) => [block, list.map((r) => r.id)])).toEqual([['block-2', ['moved', 'found']]]);
    expect(rest).toEqual([]);
  });
});

describe('a message holding a comment thread still open opens unfolded', () => {
  const comment = (id: string, message_id: string, message = true) => ({ id, message_id, ...(message ? { message: { id: message_id } } : {}) }) as unknown as InboxAnnotationRecord;

  test('open, or resolved with a sub-thread open under it: its message; resolved with nothing open, or a file comment: none', () => {
    const comments = [comment('open', 'm1'), comment('kept', 'm2'), comment('done', 'm3'), comment('file', 'm4', false)];
    expect([...messagesWithOpenThreads(comments, new Set(['kept', 'done']), new Set(['kept']))]).toEqual(['m1', 'm2']);
  });

  const fold = (folded: string[], hidden: string[][], revealed: number[] = []) => ({ folded: new Set(folded), hidden, revealed: new Set(revealed) });

  test('out of its fold and of "N earlier messages", the run cut around it; the others stay as they are', () => {
    const next = unfoldOpenThreads(fold(['a0', 'r0', 'a1', 'r1', 'a2', 'r2'], [['r0', 'a1', 'r1']]), new Set(['a1']));
    expect([...next.folded]).toEqual(['a0', 'r0', 'r1', 'a2', 'r2']);
    expect(next.hidden).toEqual([['r0'], ['r1']]);
  });

  test('once: the person may fold it again; a run the person opened stays open; nothing to open, the same fold', () => {
    const once = unfoldOpenThreads(fold(['a0', 'a1', 'a2', 'a3', 'a4'], [['a1', 'a2']], [0]), new Set(['a3']));
    expect(once.hidden).toEqual([]);
    const foldedAgain = { ...once, folded: new Set([...once.folded, 'a3']) };
    expect(unfoldOpenThreads(foldedAgain, new Set(['a3']))).toBe(foldedAgain);
    const none = fold(['a0'], []);
    const kept = unfoldOpenThreads(none, new Set(['open-elsewhere']));
    expect(kept.folded).toBe(none.folded);
    expect(unfoldOpenThreads(kept, new Set(['open-elsewhere']))).toBe(kept);
  });
});
