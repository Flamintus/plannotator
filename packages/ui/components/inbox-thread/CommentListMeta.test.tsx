/**
 * The line a flat list adds under one comment (`CommentListMeta`): a draft
 * says "Not sent" and has Send (once, again only when it did not go); a sent
 * one its round, its send's status, "Resolved" with Reopen (Resolve while
 * open), and how many replies are under its passage, never their words;
 * nothing at all when there is nothing to say.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const meta = (hasDom ? await import('./CommentListMeta') : {}) as typeof import('./CommentListMeta');

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

async function draw(element: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

test.skipIf(!hasDom)('a draft: "Not sent" and Send, pressed once, again only when it did not go', async () => {
  const pressed: number[] = [];
  let answer = false;
  const host = await draw(<meta.CommentListMeta draft onSend={async () => { pressed.push(1); return answer; }} />);
  expect(host.querySelector('[data-comment-meta-round]')?.textContent).toBe('Not sent');
  const send = host.querySelector<HTMLButtonElement>('[data-comment-meta-send]')!;
  await act(async () => send.click());
  expect(send.disabled).toBe(false);
  answer = true;
  await act(async () => send.click());
  expect(pressed).toHaveLength(2);
  expect(send.disabled).toBe(true);
});

test.skipIf(!hasDom)('a sent thread: its round, status, Resolved with Reopen, and the replies under its passage counted', async () => {
  const resolved: boolean[] = [];
  const host = await draw(<meta.CommentListMeta round={2} status="replied" resolved replies={3} onResolve={(next) => resolved.push(next)} />);
  expect(host.querySelector('[data-comment-meta-round]')?.textContent).toBe('Round 2');
  expect(host.querySelector('[data-comment-meta-status="replied"]')?.textContent).toBe('Replied');
  expect(host.querySelector('[data-comment-meta-resolved]')?.textContent).toBe('Resolved');
  expect(host.querySelector('[data-comment-meta-replies]')?.textContent).toBe('↳ 3 replies under the passage');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-comment-meta-resolve="reopen"]')!.click());
  expect(resolved).toEqual([false]);
  expect(meta.repliesUnderPassage(1)).toBe('↳ 1 reply under the passage');
});

test.skipIf(!hasDom)('an open thread offers Resolve; a reply (no state of its own) none; nothing to say draws nothing', async () => {
  const open = await draw(<meta.CommentListMeta round={1} resolved={false} onResolve={() => {}} />);
  expect(open.querySelector('[data-comment-meta-resolve="resolve"]')).not.toBeNull();
  expect(open.querySelector('[data-comment-meta-resolved]')).toBeNull();
  await act(async () => root!.unmount());
  const reply = await draw(<meta.CommentListMeta round={1} onResolve={() => {}} />);
  expect(reply.querySelector('[data-comment-meta-resolve]')).toBeNull();
  await act(async () => root!.unmount());
  const none = await draw(<meta.CommentListMeta />);
  expect(none.querySelector('[data-comment-meta]')).toBeNull();
});
