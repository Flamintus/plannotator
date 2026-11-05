/**
 * The comment thread boxes (`SentThreads`), drawn from props alone, as a host
 * of the shared thread parts draws them (the Inbox's own DOM tests run them
 * inside the window over a real Inbox: packages/inbox/sentComments.dom.test.tsx).
 * What can regress:
 *  - the tree: a thread's box holds its comment, then its replies; a
 *    sub-thread is a box in the box, under the message its passage is on,
 *    the passage marked in that message's words;
 *  - a host that passes no action gets no control and no passage to select;
 *  - the fold: a resolved thread folds to one line only once nothing under it
 *    is open, a press opens it to be read and its chevron folds it again;
 *  - Reply and Resolve call the host with the thread, the box's key saves and
 *    never reaches the page (the Inbox's Send listens on the window), a save
 *    the host refused keeps the words, Escape closes;
 *  - words selected in a sent message open a comment on that passage, saved
 *    with the message, the passage and its offset;
 *  - with comment sends: a draft (a comment, a reply under one, a sub-thread)
 *    has Send, which calls the host with its id and stays disabled once it
 *    went (pressed again only when it did not); a sent element shows its
 *    status, a live thread says so, an agent's reply not seen yet is New;
 *    without `onSend` a draft has no Send.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isInboxCommentThreadFolded } from '@plannotator/core/inbox-comment-threads';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { SentCommentsTree } from './sentCommentsTree';

const hasDom = typeof document !== 'undefined';
const parts = (hasDom ? await import('./SentThreads') : {}) as typeof import('./SentThreads');

type Actions = Pick<ComponentProps<typeof parts.SentThreads>, 'onOpen' | 'onResolve' | 'onReply' | 'onSubThread' | 'onSend'>;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

/** A comment the person sent (`sent`: the reply that carried it; null, a draft). */
function record(id: string, text: string, quote: string, extra: Partial<InboxAnnotationRecord> = {}): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_1',
    thread_id: 'thr_1',
    message_id: 'msg_a1',
    attachment_id: '',
    path: 'msg_a1',
    version: 'current',
    annotation: { id, blockId: 'block-0', type: 'COMMENT', text, originalText: quote, startOffset: 0, endOffset: quote.length, createdA: 1 },
    created_at: '2026-11-05T10:00:00.000Z',
    updated_at: '2026-11-05T10:00:00.000Z',
    removed_at: null,
    sent_reply_id: 'msg_p1',
    ...extra,
  } as InboxAnnotationRecord;
}

const REPLY = 'Nobody today. I propose three steps, the last one through the feature-flag switch.';
const comment = record('c1', 'Who watches sales at night?', 'turns the new checkout off');
const sub = record('s1', 'Which switch?', 'feature-flag switch', { parent: 'r1', quote_offset: REPLY.indexOf('feature-flag switch'), sent_reply_id: 'msg_p2' });

/** c1 with the agent's reply r1, and the sub-thread s1 on r1's words, open. */
const TREE: SentCommentsTree = {
  rounds: new Map([['msg_p1', 1], ['msg_p2', 2]]),
  resolved: new Set(),
  replies: new Map([['c1', [{ id: 'r1', who: 'Claude Code', round: 1, text: REPLY, at: '2026-11-05T10:01:00.000Z', draft: false }]]]),
  subThreads: new Map([['r1', [sub]]]),
  openBelow: new Set(['c1', 'r1']),
  passages: new Map([['r1', [{ quote: 'feature-flag switch', offset: REPLY.indexOf('feature-flag switch') }]]]),
};

/** The host's side: one surface's view of its threads, folding as the Inbox does. */
function Threads({ records, tree, actions }: { records: readonly InboxAnnotationRecord[]; tree: SentCommentsTree; actions: Actions }) {
  const ids = [...records, ...[...tree.subThreads.values()].flat()].map((r) => r.id);
  const folded = new Set(ids.filter((id) => isInboxCommentThreadFolded(id, tree.resolved, tree.openBelow)));
  const view = parts.useSentThreadsView(!!actions.onSubThread, folded);
  return <parts.SentThreads group="block-0" records={records} tree={tree} view={view} {...actions} />;
}

async function render(records: readonly InboxAnnotationRecord[], tree: SentCommentsTree, actions: Actions = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Threads records={records} tree={tree} actions={actions} />);
  });
}

const box = (id: string) => document.querySelector<HTMLElement>(`[data-sent-comment="${id}"]`);
const click = async (el: Element | null) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => (el as HTMLElement).click());
};

async function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(field: HTMLTextAreaElement, init: KeyboardEventInit) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

describe.skipIf(!hasDom)('SentThreads', () => {
  test("a thread's box holds its comment, then its replies; a sub-thread is a box in the box, under the message its passage is on", async () => {
    await render([comment], TREE);
    const c1 = box('c1')!;
    expect(c1.querySelector(':scope > .ib-sentb-head [data-sent-round="1"]')).not.toBeNull();
    expect(c1.querySelector(':scope > [data-sent-message="c1"]')).not.toBeNull();
    const reply = c1.querySelector<HTMLElement>(':scope > [data-sent-replies="c1"] > [data-sent-reply="r1"]')!;
    expect(reply.querySelector('[data-sent-body]')!.textContent).toBe(REPLY);
    // The sub-thread sits under the reply whose words it is on, after them, its passage marked there.
    const s1 = reply.querySelector<HTMLElement>(':scope > [data-sent-subthreads="r1"] > [data-sent-comment="s1"]')!;
    expect(s1.hasAttribute('data-sent-subthread')).toBe(true);
    expect(s1.querySelector('.ib-sentb-head [data-sent-round="2"]')).not.toBeNull();
    expect([...reply.children].map((el) => el.className)).toEqual(['ib-sentb-meta', 'ib-sentc-said', 'ib-sentb-subs']);
    expect([...reply.querySelectorAll('mark[data-passage-mark]')].map((m) => m.textContent)).toEqual(['feature-flag switch']);
    // No action passed: nothing to press but the chevron that folds the box (any box folds), nothing to select a passage in, and the quote is words.
    expect(document.querySelector('[data-sent-reply-to], [data-sent-resolve], [data-passage-body]')).toBeNull();
    expect([...c1.querySelectorAll(':scope > .ib-sentb-head button')].map((button) => button.getAttribute('data-sent-unfold'))).toEqual(['c1']);
  });

  test('a resolved thread folds to one line only once nothing under it is open; a press opens it to be read, its chevron folds it again', async () => {
    const done = record('c2', 'Ship it on Monday.', 'the rollout date');
    const tree: SentCommentsTree = {
      ...TREE,
      resolved: new Set(['c1', 'c2']),
      replies: new Map([...TREE.replies, ['c2', [{ id: 'r2', who: 'You', round: 1, text: 'Monday it is.', at: '2026-11-05T10:02:00.000Z', draft: false }]]]),
    };
    await render([comment, done], tree, { onResolve: () => {} });
    // c1 is resolved but its sub-thread is open: unfolded, marked Resolved (with its check), the sub-thread in view, open.
    expect(box('c1')!.hasAttribute('data-sent-folded')).toBe(false);
    expect(box('c1')!.hasAttribute('data-sent-resolved')).toBe(true);
    expect(box('c1')!.querySelector(':scope > .ib-sentb-head [data-sent-resolved-chip] [data-icon="check"]')).not.toBeNull();
    expect(box('s1')).not.toBeNull();
    expect(box('s1')!.querySelector('[data-sent-resolved-chip]')).toBeNull();
    // c2 has nothing open under it: one line, counting its messages, no message drawn.
    const line = box('c2')!;
    expect(line.hasAttribute('data-sent-folded')).toBe(true);
    const unfold = line.querySelector<HTMLElement>('[data-sent-unfold="c2"]')!;
    expect(unfold.getAttribute('aria-expanded')).toBe('false');
    const count = line.querySelector('[data-sent-messages]')!;
    expect([count.getAttribute('data-sent-messages'), count.getAttribute('data-sent-subthreads')]).toEqual(['2', '0']);
    expect(line.querySelector('[data-sent-message], [data-sent-resolve]')).toBeNull();
    expect(line.querySelector('[data-sent-resolved-chip]')?.textContent).toBe('Resolved');

    await click(unfold);
    expect(box('c2')!.hasAttribute('data-sent-folded')).toBe(false);
    expect(box('c2')!.querySelector('[data-sent-reply="r2"]')).not.toBeNull();
    expect(box('c2')!.querySelector('[data-sent-resolve="c2"]')).not.toBeNull();
    await click(box('c2')!.querySelector('[data-sent-unfold="c2"][aria-expanded="true"]'));
    expect(box('c2')!.hasAttribute('data-sent-folded')).toBe(true);
  });

  test("Reply and Resolve call the host; the box's key saves and never reaches the page, a refused save keeps the words, Escape closes", async () => {
    const calls: unknown[][] = [];
    const answers = [false, true];
    await render([comment], TREE, {
      onOpen: (r) => calls.push(['open', r.id]),
      onResolve: (r, resolved) => calls.push(['resolve', r.id, resolved]),
      onReply: async (id, reply) => {
        calls.push(['reply', id, reply]);
        return answers.shift()!;
      },
    });
    await click(box('c1')!.querySelector('button.ib-sentb-quote'));
    // A sub-thread's passage is in the message just above it: its quote is no button.
    expect(box('s1')!.querySelector('button.ib-sentb-quote')).toBeNull();
    await click(box('c1')!.querySelector('[data-sent-resolve="c1"]'));
    expect(calls.splice(0)).toEqual([['open', 'c1'], ['resolve', 'c1', true]]);

    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => heard.push(event.key);
    window.addEventListener('keydown', listen);
    try {
      await click(box('c1')!.querySelector('[data-sent-reply-to="c1"]'));
      const field = () => box('c1')!.querySelector<HTMLTextAreaElement>(':scope > [data-sent-replies="c1"] > .ib-sentb-boxrow textarea')!;
      await type(field(), '  Then who answers the pager?  ');
      await key(field(), { key: 'Enter', metaKey: true });
      // Refused: the box stays with the words.
      expect(field().value).toBe('  Then who answers the pager?  ');
      await click(box('c1')!.querySelector('[data-sent-reply-save]'));
      expect(field()).toBeNull();
      expect(calls).toEqual([
        ['reply', 'c1', { text: 'Then who answers the pager?' }],
        ['reply', 'c1', { text: 'Then who answers the pager?' }],
      ]);

      await click(box('c1')!.querySelector('[data-sent-reply-to="c1"]'));
      await key(field(), { key: 'Escape' });
      expect(field()).toBeNull();
      expect(heard).toEqual([]);
    } finally {
      window.removeEventListener('keydown', listen);
    }
  });

  test('with comment sends: each draft has Send, which goes once; a sent element says what became of it, a live thread and a new reply say so', async () => {
    const draft = record('c3', 'Lyon first.', 'every store', { sent_reply_id: null });
    const draftSub = record('s2', 'Which three?', 'three steps', { parent: 'r1', quote_offset: REPLY.indexOf('three steps'), sent_reply_id: null });
    const tree: SentCommentsTree = {
      ...TREE,
      replies: new Map([
        [
          'c1',
          [
            ...TREE.replies.get('c1')!,
            { id: 'p1', who: 'You', round: 2, text: 'And the pager?', at: '2026-11-05T10:03:00.000Z', draft: false },
            { id: 'p2', who: 'You', round: undefined, text: 'And the lead?', at: '2026-11-05T10:04:00.000Z', draft: true },
          ],
        ],
      ]),
      subThreads: new Map([['r1', [sub, draftSub]]]),
      statuses: new Map([
        ['c1', 'replied'],
        ['p1', 'working'],
      ]),
      live: new Set(['c1']),
      fresh: new Set(['r1']),
    };
    // Without onSend, a draft has nothing to press.
    await render([comment, draft], tree);
    expect(document.querySelector('[data-sent-send]')).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    host?.remove();

    const sent: string[] = [];
    const answers = [false, true, true, true];
    await render([comment, draft], tree, {
      onSend: async (id) => {
        sent.push(id);
        return answers.shift()!;
      },
    });
    // What became of each sent element (status words pinned on purpose: they are the decision's), the live thread, the new reply.
    expect(box('c1')!.querySelector(':scope > .ib-sentb-head [data-sent-status="replied"]')!.textContent).toBe('Replied');
    expect(box('c1')!.querySelector('[data-sent-reply="p1"] [data-sent-status="working"]')!.textContent).toBe('Working');
    expect(box('c1')!.querySelector(':scope > .ib-sentb-head [data-sent-live]')).not.toBeNull();
    expect(box('c1')!.querySelector('[data-sent-reply="r1"]')!.hasAttribute('data-sent-new')).toBe(true);
    expect(box('c1')!.querySelector('[data-sent-reply="p1"]')!.hasAttribute('data-sent-new')).toBe(false);
    // Sent things have no Send: only the three drafts (the comment, the reply, the sub-thread).
    expect([...document.querySelectorAll('[data-sent-send]')].map((b) => b.getAttribute('data-sent-send')).sort()).toEqual(['c3', 'p2', 's2']);
    expect(box('c3')!.hasAttribute('data-sent-draft')).toBe(true);
    expect(box('c3')!.querySelector('[data-sent-reply-to], [data-sent-resolve]')).toBeNull();

    // A refused Send can be pressed again; one that went stays disabled until the host draws it sent.
    const press = async (id: string) => click(document.querySelector(`[data-sent-send="${id}"]`));
    await press('c3');
    expect(document.querySelector<HTMLButtonElement>('[data-sent-send="c3"]')!.disabled).toBe(false);
    await press('c3');
    expect(document.querySelector<HTMLButtonElement>('[data-sent-send="c3"]')!.disabled).toBe(true);
    await press('p2');
    await press('s2');
    expect(sent).toEqual(['c3', 'c3', 'p2', 's2']);
  });

  test("words selected in a sent message open a comment on that passage under it, saved with the message, the passage and its offset", async () => {
    const saved: unknown[][] = [];
    await render([comment], TREE, {
      onSubThread: async (parentId, passage, words) => {
        saved.push([parentId, passage, words]);
        return true;
      },
    });
    const body = box('c1')!.querySelector<HTMLElement>('[data-sent-reply="r1"] [data-passage-body="r1"]')!;
    // The words before the marked passage, the first piece of the body.
    const text = body.firstChild!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, REPLY.indexOf('three steps'));
    range.setEnd(text, REPLY.indexOf('three steps') + 'three steps'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });
    // The selection toolbar's Comment action, found by its label on purpose (an action label, as in AnnotationPanel.passage.test.tsx).
    await click(document.querySelector('button[title="Comment"]'));
    const composer = box('c1')!.querySelector<HTMLElement>('[data-sent-reply="r1"] > [data-sent-subthreads="r1"] > [data-sent-passage-box]')!;
    expect(composer.querySelector('.ib-sentc-boxquote')!.textContent).toContain('three steps');
    await type(composer.querySelector('textarea')!, 'Which three?');
    await click(composer.querySelector('[data-sent-reply-save]'));
    expect(saved).toEqual([['r1', { quote: 'three steps', offset: REPLY.indexOf('three steps') }, { text: 'Which three?' }]]);
    expect(box('c1')!.querySelector('[data-sent-passage-box]')).toBeNull();
  });

  test('a comment on the whole document (no passage) says so at its head and on its folded line; one on part of an image does not', async () => {
    const region = record('i1', 'Crop this.', '');
    await render([region], { ...TREE, replies: new Map(), subThreads: new Map(), openBelow: new Set() });
    expect(box('i1')!.querySelector('.ib-sentb-general')).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    const general = record('g1', 'Split this plan in two.', '');
    general.annotation = { ...general.annotation, type: 'GLOBAL_COMMENT' };
    await render([general], { ...TREE, replies: new Map(), subThreads: new Map(), openBelow: new Set() });
    expect(box('g1')!.querySelector('.ib-sentb-head .ib-sentb-general')?.textContent).toBe('General comment');
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    await render([general], { ...TREE, resolved: new Set(['g1']), replies: new Map(), subThreads: new Map(), openBelow: new Set() });
    expect(box('g1')!.querySelector('.ib-sentb-fquote')?.textContent).toBe('General comment');
  });
});
