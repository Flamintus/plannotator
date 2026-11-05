/**
 * The boxes' props built from the neutral thread view alone
 * (`sentThreadsFromView`), as a host with no records of its own (the
 * screens' review loop) builds them. What can regress: each sent thread's
 * round by what carried it, resolved threads, the fold kept open while
 * something under a resolved thread is open (a sub-thread, or the host's own
 * draft), the host's draft replies and sub-threads listed after the view's,
 * the passages marked, statuses and live threads, a thread's drawing data
 * from the host when it holds it.
 */
import { describe, expect, test } from 'bun:test';
import type { ReviewReplyNode, ReviewThreadNode, ReviewThreadView } from '@plannotator/core/review-threads';
import { placeThreads, sentThreadsFromView } from './sentCommentsTree';

const thread = (id: string, extra: Partial<ReviewThreadNode> = {}): ReviewThreadNode => ({
  id,
  reply_id: `snd_${id}`,
  round: 1,
  draft: false,
  state: 'open',
  on: { kind: 'file', path: 'notes.md' },
  quote: `words of ${id}`,
  text: `comment ${id}`,
  unanchored: false,
  type: 'comment',
  folded: false,
  live: false,
  replies: [],
  sub_threads: [],
  ...extra,
});

const agentReply = (id: string, extra: Partial<ReviewReplyNode> = {}): ReviewReplyNode => ({
  id,
  author: { kind: 'agent', host: 'claude-code', session: 's1', name: null },
  author_name: 'Claude Code',
  round: 1,
  message_id: '',
  text: `reply ${id}`,
  at: '2026-11-05T10:00:00.000Z',
  draft: false,
  sub_threads: [],
  ...extra,
});

const view = (threads: ReviewThreadNode[]): ReviewThreadView => ({ v: 1, round: 2, threads });

describe('sentThreadsFromView', () => {
  test("rounds by carrier, resolved threads, statuses and live threads; the agent's replies under their thread", () => {
    const built = sentThreadsFromView(
      view([
        thread('c1', { status: 'replied', live: true, replies: [agentReply('rep_1')] }),
        thread('c2', { reply_id: 'snd_2', round: 2, state: 'resolved', folded: true }),
      ]),
      { fresh: new Set(['rep_1']) },
    );
    expect(built.threads.map((record) => [record.id, record.sent_reply_id])).toEqual([['c1', 'snd_c1'], ['c2', 'snd_2']]);
    expect([...built.tree.rounds]).toEqual([['snd_c1', 1], ['snd_2', 2]]);
    expect([...built.tree.resolved]).toEqual(['c2']);
    expect(built.tree.statuses?.get('c1')).toBe('replied');
    expect([...(built.tree.live ?? [])]).toEqual(['c1']);
    expect(built.tree.replies.get('c1')?.map((row) => [row.who, row.text, row.draft])).toEqual([['Claude Code', 'reply rep_1', false]]);
    expect(built.tree.fresh?.has('rep_1')).toBe(true);
    // Nothing open under the resolved one: it folds.
    expect(built.tree.openBelow.has('c2')).toBe(false);
  });

  test('a resolved thread stays unfolded while a sub-thread under it is open, at any depth, or while the host holds a draft under it', () => {
    const deep = thread('s2', { parent: { id: 'rep_1', quote_offset: 0 }, quote: 'reply' });
    const resolvedWithSub = thread('c1', { state: 'resolved', replies: [agentReply('rep_1', { sub_threads: [deep] })] });
    const resolvedWithDraft = thread('c2', { state: 'resolved' });
    const built = sentThreadsFromView(view([resolvedWithSub, resolvedWithDraft]), {
      drafts: { replies: new Map([['c2', [{ id: 'd1', who: 'You', round: undefined, text: 'One more thing.', at: '2026-11-05T11:00:00.000Z', draft: true }]]]) },
    });
    expect(built.tree.openBelow.has('c1')).toBe(true);
    expect(built.tree.openBelow.has('c2')).toBe(true);
    // The open sub-thread is under the reply it is on, its passage marked there; the draft reply after the view's.
    expect(built.tree.subThreads.get('rep_1')?.map((record) => [record.id, record.parent])).toEqual([['s2', 'rep_1']]);
    expect(built.tree.passages.get('rep_1')).toEqual([{ quote: 'reply', offset: 0 }]);
    expect(built.tree.replies.get('c2')?.map((row) => row.id)).toEqual(['d1']);
  });

  test("the host's draft sub-threads and their passages join the view's; a resolved sub-thread's passage stays marked", () => {
    const done = thread('s1', { parent: { id: 'c1', quote_offset: 3 }, quote: 'old', state: 'resolved', folded: true });
    const built = sentThreadsFromView(view([thread('c1', { sub_threads: [done] })]), {
      drafts: {
        subThreads: new Map([['c1', [{ id: 'ann-passage-1', annotation: { originalText: 'new', text: 'Why?' }, sent_reply_id: null, parent: 'c1' }]]]),
        passages: new Map([['c1', [{ quote: 'new', offset: 9 }]]]),
      },
    });
    expect(built.tree.subThreads.get('c1')?.map((record) => record.id)).toEqual(['s1', 'ann-passage-1']);
    expect(built.tree.passages.get('c1')?.map((mark) => mark.quote)).toEqual(['old', 'new']);
    expect(built.tree.openBelow.has('c1')).toBe(true);
  });

  test("a thread's drawing data is the host's when it holds it (its block), else the view's words; placed under that block", () => {
    const built = sentThreadsFromView(view([thread('c1'), thread('c2', { unanchored: true })]), {
      annotationOf: (id) => (id === 'c1' ? { originalText: 'words of c1', text: 'comment c1', blockId: 'block-3' } : undefined),
    });
    expect(built.threads[1]!.annotation).toEqual({ originalText: 'words of c2', text: 'comment c2' });
    const { byBlock, rest } = placeThreads(built.threads, new Set(['block-3']));
    expect(byBlock.get('block-3')?.map((record) => record.id)).toEqual(['c1']);
    // Unanchored: at the end.
    expect(rest.map((record) => record.id)).toEqual(['c2']);
  });
});
