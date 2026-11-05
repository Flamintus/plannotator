/**
 * What a screen's page reads of its review loop and sends back. A sent
 * comment that still counted as feedback would reach the agent again (in the
 * next round, or as approval notes); a reply sent without its thread's id, or
 * a sub-thread without its passage, would read to the agent as a new comment
 * somewhere else; a card drawn on the wrong document, or a new message that
 * moved the picker's selection, would show the person something they did not
 * pick.
 */
import { describe, expect, test } from 'bun:test';
import type { ReviewReplyNode, ReviewThreadNode, ReviewThreadView } from '@plannotator/core/review-threads';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import {
  indexReviewLoop,
  mergeHostMessages,
  readReviewLoopState,
  reviewLoopCards,
  reviewLoopCommentInputs,
  reviewLoopPassages,
  withoutSent,
} from './reviewLoop';

const annotation = (id: string, extra: Partial<Annotation> = {}): Annotation => ({
  id, blockId: 'b1', startOffset: 0, endOffset: 4, type: AnnotationType.COMMENT, text: `words of ${id}`, originalText: 'Ship to all stores.', createdA: 10, ...extra,
});

const agentReply = (id: string, extra: Partial<ReviewReplyNode> = {}): ReviewReplyNode => ({
  id, author: { kind: 'agent', host: 'claude-code', session: 's1', name: null }, author_name: 'Claude Code', round: 1, message_id: '', text: 'Tuesday 10:00 then?', at: '2026-11-05T10:00:00.000Z', draft: false, sub_threads: [], ...extra,
});

const thread = (id: string, extra: Partial<ReviewThreadNode> = {}): ReviewThreadNode => ({
  id, reply_id: 'snd_01JCCCCCCCCCCCCCCCCCCCCCCC', round: 1, draft: false, state: 'open', on: { kind: 'file', path: '/w/release.md' }, quote: 'Ship to all stores.', text: `words of ${id}`, unanchored: false, folded: false, live: false, status: 'replied', replies: [], sub_threads: [], ...extra,
});

const view = (threads: ReviewThreadNode[], round = 2): ReviewThreadView => ({ v: 1, round, threads });

describe('readReviewLoopState', () => {
  test('only an available loop with a v1 view is read; anything else leaves the page as today', () => {
    expect(readReviewLoopState({ available: false })).toBeNull();
    expect(readReviewLoopState({})).toBeNull();
    expect(readReviewLoopState({ available: true, review: 'k', round: 1, busy: false, view: { v: 2, round: 1, threads: [] } })).toBeNull();
    expect(readReviewLoopState({ available: true, review: 'k', round: 1, busy: false, view: view([]) })?.review).toBe('k');
  });
});

describe('indexReviewLoop', () => {
  const sub = thread('sub1', { quote: 'Tuesday', parent: { id: 'rep_1', quote_offset: 0 }, state: 'open' });
  const resolved = thread('c2', { state: 'resolved', folded: true, replies: [agentReply('rep_2')] });
  const index = indexReviewLoop(view([
    thread('c1', { replies: [agentReply('rep_1', { sub_threads: [sub] })] }),
    resolved,
    thread('draft1', { draft: true, reply_id: '' }),
  ]));

  test('what a send carried and every agent reply are sent; a draft in the journal is not', () => {
    expect([...index.sent].sort()).toEqual(['c1', 'c2', 'rep_1', 'rep_2', 'sub1']);
  });

  test('the count is the round under way and the sent threads still open, sub-threads included', () => {
    expect(index.count).toEqual({ round: 2, open: 2 });
    expect(indexReviewLoop(view([thread('d', { draft: true })])).count).toBeNull();
  });

  test('each element knows its thread, its top thread and what it is drawn under; under a folded thread it is hidden', () => {
    expect(index.elements.get('sub1')).toMatchObject({ under: 'rep_1', top: { id: 'c1' }, thread: { id: 'sub1' }, hidden: false });
    expect(index.elements.get('rep_1')).toMatchObject({ under: 'c1', thread: { id: 'c1' } });
    expect(index.elements.get('rep_2')?.hidden).toBe(true);
    expect(index.elements.get('c2')?.hidden).toBe(false);
  });
});

describe('withoutSent', () => {
  test('nothing sent: the very same list (the page as today); else the sent ones are left out', () => {
    const list = [annotation('a'), annotation('b')];
    expect(withoutSent(list, new Set())).toBe(list);
    expect(withoutSent(list, new Set(['x']))).toBe(list);
    expect(withoutSent(list, new Set(['a'])).map((a) => a.id)).toEqual(['b']);
  });
});

describe('reviewLoopCommentInputs', () => {
  const index = indexReviewLoop(view([thread('c1', { replies: [agentReply('rep_1')] })]));
  const replyToAgent = annotation('reply-1', { inReplyTo: 'rep_1', text: 'Yes, Tuesday.' });
  const replyToReply = annotation('reply-2', { inReplyTo: 'reply-1', text: 'And EU first.' });
  const passage = annotation('ann-passage-1', { inReplyTo: 'rep_1', originalText: 'Tuesday', text: 'Why Tuesday?' });
  const byId = new Map([replyToAgent, replyToReply, passage].map((a) => [a.id, a]));

  test('a reply goes under its thread, also through a reply draft; a sub-thread names its message and passage', () => {
    const inputs = reviewLoopCommentInputs([{ on: { kind: 'file', path: '/w/release.md' }, annotations: [replyToAgent, replyToReply, passage] }], { index, byId, offsets: new Map([['ann-passage-1', 0]]) });
    expect(inputs).toEqual([
      { id: 'reply-1', re: 'c1', text: 'Yes, Tuesday.' },
      { id: 'reply-2', re: 'c1', text: 'And EU first.' },
      { id: 'ann-passage-1', parent: 'rep_1', quote: 'Tuesday', quote_offset: 0, text: 'Why Tuesday?' },
    ]);
  });

  test('a comment is on its place with its words; a general comment has none; a deletion and images say so', () => {
    const on = { kind: 'message' as const, message_id: 'm1' };
    const [comment, general, deletion] = reviewLoopCommentInputs([{ on, annotations: [
      annotation('a'),
      annotation('g', { type: AnnotationType.GLOBAL_COMMENT, originalText: '', text: '' , images: [{ name: 'shot', path: '/tmp/shot.png' }] }),
      annotation('d', { type: AnnotationType.DELETION, text: undefined }),
    ] }], { index, byId: new Map(), offsets: new Map() });
    expect(comment).toMatchObject({ id: 'a', on, quote: 'Ship to all stores.', text: 'words of a' });
    expect(comment!.re).toBeUndefined();
    expect(general).toMatchObject({ id: 'g', quote: '', notes: ['Attached images:', '- [shot] `/tmp/shot.png`'] });
    expect(general!.text.trim()).not.toBe('');
    expect(deletion).toMatchObject({ id: 'd', type: 'deletion', text: '' });
  });
});

describe('reviewLoopCards', () => {
  const index = indexReviewLoop(view([
    thread('c1', { replies: [agentReply('rep_1')] }),
    thread('other', { on: { kind: 'file', path: '/w/other.md' }, replies: [agentReply('rep_9')] }),
  ]));
  const here = (top: ReviewThreadNode) => top.on.kind === 'file' && top.on.path === '/w/release.md';

  test('the agent reply is a card under its comment, at the comment\'s place; a held card and another document\'s are not drawn again', () => {
    const held = new Map([['c1', annotation('c1', { blockId: 'b7', startMeta: { parentTagName: 'P', parentIndex: 2, textOffset: 0 } })]]);
    const cards = reviewLoopCards({ index, held, here, person: 'Swift Tater' });
    expect(cards.map((card) => card.id)).toEqual(['rep_1']);
    expect(cards[0]).toMatchObject({ inReplyTo: 'c1', author: 'Claude Code', blockId: 'b7', text: 'Tuesday 10:00 then?', createdA: Date.parse('2026-11-05T10:00:00.000Z') });
  });

  test('a sent comment the page does not hold (another client\'s) is drawn too, as the person\'s', () => {
    const cards = reviewLoopCards({ index, held: new Map(), here, person: 'Swift Tater' });
    expect(cards.map((card) => card.id).sort()).toEqual(['c1', 'rep_1']);
    expect(cards.find((card) => card.id === 'c1')).toMatchObject({ author: 'Swift Tater', originalText: 'Ship to all stores.' });
    expect(cards.find((card) => card.id === 'c1')!.inReplyTo).toBeUndefined();
  });
});

describe('reviewLoopPassages', () => {
  test('an open sub-thread marks its passage in its message; a draft one too, found in the words when its offset is unknown', () => {
    const index = indexReviewLoop(view([thread('c1', { sub_threads: [thread('s1', { quote: 'all stores', parent: { id: 'c1', quote_offset: 8 } })] })]));
    const draft = annotation('ann-passage-2', { inReplyTo: 'c1', originalText: 'words' });
    const passages = reviewLoopPassages({ index, drafts: [draft], offsets: new Map(), wordsOf: () => 'the words of c1' });
    expect(passages.get('c1')).toEqual([{ quote: 'all stores', offset: 8 }, { quote: 'words', offset: 4 }]);
  });
});

describe('mergeHostMessages', () => {
  const shown = [{ messageId: 'm2', text: 'Second (as shown)' }, { messageId: 'm1', text: 'First' }];

  test('a new message joins the picker in the session\'s order; a shown one keeps its words', () => {
    const merged = mergeHostMessages(shown, [{ messageId: 'm3', text: 'Third' }, { messageId: 'm2', text: 'Second (newer words)' }, { messageId: 'm1', text: 'First' }], null);
    expect(merged?.messages.map((m) => m.messageId)).toEqual(['m3', 'm2', 'm1']);
    expect(merged?.messages[1]?.text).toBe('Second (as shown)');
    expect(merged?.opened).toBeUndefined();
  });

  test('nothing new, or not a list: no change', () => {
    expect(mergeHostMessages(shown, [{ messageId: 'm2', text: 'x' }], null)).toBeNull();
    expect(mergeHostMessages(shown, { messages: [] }, null)).toBeNull();
  });

  test('a screen opened on one message names it from the list by its words, or leaves the list alone', () => {
    const incoming = [{ messageId: 'm2', text: 'Next answer' }, { messageId: 'm1', text: ' The opened message \n' }];
    expect(mergeHostMessages([], incoming, 'The opened message')).toEqual({ messages: incoming, opened: 'm1' });
    expect(mergeHostMessages([], incoming, 'Something else')).toBeNull();
  });
});
