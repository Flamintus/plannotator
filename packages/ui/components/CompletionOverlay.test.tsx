/**
 * The message after a decision (`CompletionOverlay`). Without `onDismiss` it
 * is today's full-screen message. With it (the review loop, as crit's review
 * dialog), the message is a card over the page: a press outside it (not the
 * rest of the click that opened it), Escape, or "Back to the page" takes it
 * away; and while the review goes on in the tab (`reviewContinues`) it says
 * so and never starts closing the tab.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';

const hasDom = typeof document !== 'undefined';
const overlay = (hasDom ? await import('./CompletionOverlay') : {}) as typeof import('./CompletionOverlay');

let root: Root | null = null;
const memory = new Map<string, string>();

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  memory.clear();
  resetStorageBackend();
  document.body.replaceChildren();
});

async function draw(element: ReactElement): Promise<HTMLElement> {
  setStorageBackend({ getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value), removeItem: (key) => void memory.delete(key) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test.skipIf(!hasDom)("without onDismiss: today's full-screen message, nothing to press back to", async () => {
  const host = await draw(<overlay.CompletionOverlay submitted="approved" title="Approved" subtitle="Claude Code will proceed." agentLabel="Claude Code" />);
  expect(host.querySelector('[data-completion-state="approved"]')).not.toBeNull();
  expect(host.querySelector('[data-completion-over-page]')).toBeNull();
  expect(host.querySelector('[data-completion-back]')).toBeNull();
});

test.skipIf(!hasDom)('over the page: the rest of the opening click is ignored, a later press outside, Escape or Back takes it away', async () => {
  let dismissed = 0;
  const host = await draw(<overlay.CompletionOverlay submitted="done" title="Done" subtitle="Claude Code was told the review is done." agentLabel="Claude Code" onDismiss={() => { dismissed += 1; }} />);
  const backdrop = host.querySelector<HTMLElement>('[data-completion-over-page]')!;
  await act(async () => backdrop.click());
  expect(dismissed).toBe(0);
  // A press inside the card is not a press outside.
  await wait(650);
  await act(async () => host.querySelector<HTMLElement>('[role="dialog"] h2')!.click());
  expect(dismissed).toBe(0);
  await act(async () => backdrop.click());
  expect(dismissed).toBe(1);
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(dismissed).toBe(2);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-completion-back]')!.click());
  expect(dismissed).toBe(3);
});

test.skipIf(!hasDom)('while the review goes on in the tab, the card says so and the tab never closes, even set to close at once', async () => {
  // "Close at once": a final message closes the tab as it opens; a round's must not.
  memory.set('plannotator-auto-close', '0');
  const closes: number[] = [];
  const close = window.close;
  window.close = () => void closes.push(1);
  try {
    const host = await draw(<overlay.CompletionOverlay submitted="feedback" title="Feedback Sent" subtitle="Round 1 sent." agentLabel="Claude Code" onDismiss={() => {}} reviewContinues />);
    expect(host.querySelector('[data-completion-continues]')?.textContent).toContain('Claude Code answers under each comment');
    await wait(50);
    expect(closes).toEqual([]);
    await act(async () => root!.unmount());
    root = null;
    await draw(<overlay.CompletionOverlay submitted="approved" title="Approved" subtitle="" agentLabel="Claude Code" onDismiss={() => {}} />);
    await wait(50);
    expect(closes).toEqual([1]);
  } finally {
    window.close = close;
  }
});
