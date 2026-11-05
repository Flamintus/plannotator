/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the whole window (InboxApp) over a REAL Inbox in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts) started with
 * PLANNOTATOR_EXPERIMENTAL=persistent-comments. What is proved: a comment on
 * an agent's message, once sent, stays highlighted and is drawn as a box
 * right under the block its passage is in (a list item's inside its list),
 * with its round, and one whose passage is not drawn at the message's end,
 * said so; a comment on a file, once sent, stays in the file's panel with
 * its round and without edit or delete, and a Markdown file draws it as a
 * box under its block too; when the agent's edit took its words away the
 * window shows it Unanchored and keeps that in the store; and the person
 * resolves a sent comment, from its box or from its card, and opens it
 * again: resolved, it leaves the highlights and folds in place to one
 * "Resolved" line (a press opens it to be read), and the store keeps it;
 * and replies sit in a sent comment's box, the agent's and the person's (a
 * draft until the next Send), and on the file's card, never painted; and
 * words selected in a sent message of a thread (the agent's reply, a card's
 * words) open a comment on that passage, a sub-thread drawn as a box under
 * that message, its passage marked, and a resolved comment stays unfolded
 * while a sub-thread under it is open, then folds with it; and comment
 * sends: a draft (a comment drawn as a box, a sub-thread) has Send, which
 * sends it alone at once and shows what became of it, the words' Send
 * carries no draft, and Finish round sends the rest with the words, the
 * header counting the round; a reply under a live thread goes on its own,
 * and Finish round with nothing else to send ends the round alone.
 * The server side is proved in packages/server/inbox-persistent-comments.test.ts,
 * inbox-comment-replies.test.ts and inbox-comment-subthreads.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { configStore } from '@plannotator/ui/config';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; filed: string; attachment: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let buffered = '';
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', filed: '', attachment: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
  const answer = await loopback(path, 'POST', JSON.stringify(body));
  if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
  return JSON.parse(answer.text);
}

async function nextLine(): Promise<string> {
  while (!buffered.includes('\n')) {
    const { value, done } = await reader!.read();
    if (done) throw new Error('the Inbox stopped');
    buffered += new TextDecoder().decode(value);
  }
  const at = buffered.indexOf('\n');
  const line = buffered.slice(0, at);
  buffered = buffered.slice(at + 1);
  return line;
}

async function command<T>(value: unknown): Promise<T> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify(value)}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return JSON.parse(await nextLine()) as T;
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-sent-comments-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '14'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), PLANNOTATOR_EXPERIMENTAL: 'persistent-comments', HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await nextLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
});

afterAll(async () => {
  if (!hasDom) return;
  reader?.releaseLock();
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  world = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}

/** A comment on selected words, as the window's viewer makes it: `blockId`, the block they are in (a message of one paragraph: `block-0`; notes.md's paragraph: `block-1`). */
function words(id: string, originalText: string, text: string, blockId = 'block-1') {
  return { id, blockId, startOffset: 0, endOffset: originalText.length, type: 'COMMENT', text, originalText, createdA: 1 };
}

test.skipIf(!hasDom)("a sent comment on an agent's message stays highlighted, and is a box right under the block its passage is in, with its round", async () => {
  // block-0 the paragraph, block-1 and block-2 the list's items, block-3 the last paragraph.
  const body = 'The backoff is now two, four and eight seconds.\n\n- Retries stop after three.\n- Then it pages the on-call.\n\nThat is all.';
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_sent_msg', body } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('sent-msg-1', 'pages the on-call', 'Cap the total wait.', 'block-2') });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('sent-msg-2', 'two, four and eight seconds', 'Why these?', 'block-0') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-msg', feedback: '# Feedback', annotation_ids: ['sent-msg-1', 'sent-msg-2'] });

  const el = await renderApp(`#thread=${sent}`);
  // A message the person answered may open folded: its sent comments are in its body.
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const row = () => el.querySelector(`[data-sent-comments] [data-sent-comment="sent-msg-1"]`);
  await until(() => row() !== null, 'the sent comment under the message');
  expect(row()!.querySelector('[data-sent-round="1"]')).not.toBeNull();
  expect(row()!.textContent).toContain('Cap the total wait.');
  expect(row()!.querySelector('.ib-sentb-head')!.textContent).toContain('pages the on-call');
  // In the flow: right after the list item it is on, inside the list, before the next item; the other under the first paragraph.
  const slot = row()!.closest<HTMLElement>('[data-viewer-below-block]')!;
  expect(slot.dataset.belowBlock).toBe('block-2');
  expect(slot.previousElementSibling!.textContent).toContain('Then it pages the on-call.');
  expect(slot.parentElement!.hasAttribute('data-pinpoint-group')).toBe(true);
  const first = el.querySelector<HTMLElement>('[data-sent-comment="sent-msg-2"]')!.closest<HTMLElement>('[data-viewer-below-block]')!;
  expect(first.previousElementSibling!.textContent).toBe('The backoff is now two, four and eight seconds.');
  expect(first.nextElementSibling!.hasAttribute('data-pinpoint-group')).toBe(true);
  expect(el.querySelector(`[data-message-id="${sent}"] [data-sent-lost]`)).toBeNull();
  await until(() => el.querySelector(`[data-message-id="${sent}"] [data-bind-id="sent-msg-1"], [data-message-id="${sent}"] [data-highlight-id="sent-msg-1"]`) !== null, "the sent comment's highlight");
  // Its words are there: nothing to keep.
  expect(posted.some((p) => p.path.includes('/unanchored'))).toBe(false);
}, 30_000);

test.skipIf(!hasDom)("a sent comment whose passage is not drawn in the message is at the message's end, said so", async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_lost_msg', body: 'Deploys run at night.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('lost-msg-1', 'at night', 'Who watches?', 'block-7') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-lost', feedback: '# Feedback', annotation_ids: ['lost-msg-1'] });

  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const lost = () => el.querySelector<HTMLElement>(`[data-message-id="${sent}"] [data-sent-lost]`);
  await until(() => lost()?.querySelector('[data-sent-comment="lost-msg-1"]') != null, 'the comment at the end');
  expect(lost()!.closest('[data-viewer-below-block]')).toBeNull();
  expect(lost()!.querySelector('.ib-sentb-lost')).not.toBeNull();
}, 30_000);

test.skipIf(!hasDom)("a sent comment on a file stays in its panel with its round, read-only, and is kept Unanchored once the agent's edit took its words away", async () => {
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: 'current', annotation: words('sent-file-1', 'The plan, in short.', 'Too short.') });
  await postJson(`/api/inbox/messages/${world.filed}/reply`, { idempotency_key: 'k-file', feedback: '# Feedback', annotation_ids: ['sent-file-1'] });
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.filed}/attachments`)).text) as { attachments: InboxAttachmentState[]; sent_comments: InboxAnnotationRecord[] };
  const path = model.attachments.find((a) => a.id === world.attachment)!.path;
  // The agent edits the file: the commented words are gone.
  writeFileSync(path, readFileSync(path, 'utf8').replace('The plan, in short.', 'The plan, at length.'));

  await renderApp(`#thread=${world.filed}&file=${world.attachment}`);
  const card = () => document.querySelector(`[data-annotation-id="sent-file-1"]`);
  await until(() => card() !== null, "the sent comment's card");
  expect(card()!.querySelector('[data-sent-round="1"]')).not.toBeNull();
  // No edit or delete: Reply and Resolve are its only buttons (the action labels are pinned on purpose).
  expect([...card()!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Reply', 'Resolve']);
  await until(() => card()!.querySelector('[data-annotation-unanchored]') !== null, 'the Unanchored chip');
  await until(() => posted.some((p) => p.path.includes('/annotations/sent-file-1/unanchored') && p.body.unanchored === true), 'the unanchored mark sent');
  await until(async () => {
    const after = JSON.parse((await loopback(`/api/inbox/threads/${world.filed}/attachments`)).text) as { sent_comments: InboxAnnotationRecord[] };
    return typeof after.sent_comments.find((r) => r.id === 'sent-file-1')?.unanchored_at === 'string';
  }, 'the mark kept in the store');
}, 30_000);

async function storedRecord(threadId: string, id: string): Promise<InboxAnnotationRecord | undefined> {
  const model = JSON.parse((await loopback(`/api/inbox/threads/${threadId}/attachments`)).text) as { sent_comments: InboxAnnotationRecord[] };
  return model.sent_comments.find((r) => r.id === id);
}

test.skipIf(!hasDom)('resolved from its box, a sent comment leaves its words and folds in place to one "Resolved" line; a press opens it to be read, Reopen brings it back', async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_resolve_msg', body: 'Retries now back off for a minute at most.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('res-msg-1', 'a minute at most', 'Why a minute?', 'block-0') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-res-msg', feedback: '# Feedback', annotation_ids: ['res-msg-1'] });

  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const row = () => el.querySelector<HTMLElement>(`[data-sent-comments] [data-sent-comment="res-msg-1"]`);
  const highlight = () => el.querySelector(`[data-message-id="${sent}"] [data-bind-id="res-msg-1"], [data-message-id="${sent}"] [data-highlight-id="res-msg-1"]`);
  await until(() => row() !== null && highlight() !== null, 'the sent comment and its highlight');

  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => row()?.hasAttribute('data-sent-folded') === true && highlight() === null, 'the resolved comment folded, its highlight gone');
  // Folded in place, under its paragraph: one line, its words and buttons out of view.
  expect(row()!.closest('[data-viewer-below-block]')).not.toBeNull();
  // The folded line's state word, Resolved, is pinned on purpose (the line holds no Resolved chip to look for).
  expect(row()!.textContent).toContain('Resolved');
  expect(row()!.textContent).not.toContain('Why a minute?');
  expect(row()!.querySelector('[data-sent-resolve]')).toBeNull();
  expect(typeof (await storedRecord(sent, 'res-msg-1'))?.resolved_at).toBe('string');

  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-unfold]')!.click());
  await until(() => row()?.hasAttribute('data-sent-folded') === false, 'the resolved comment opened to be read');
  expect(row()!.hasAttribute('data-sent-resolved')).toBe(true);
  expect(row()!.textContent).toContain('Why a minute?');
  expect(row()!.querySelector('[data-sent-resolve]')!.textContent).toBe('Reopen');
  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => highlight() !== null && row()?.hasAttribute('data-sent-resolved') === false, 'the comment open again, highlighted');
  expect((await storedRecord(sent, 'res-msg-1'))?.resolved_at).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('resolved from its card, a sent comment on a file folds to its header with Reopen, and leaves the file', async () => {
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: 'current', annotation: words('res-file-1', 'The plan, in short.', 'Say more.') });
  await postJson(`/api/inbox/messages/${world.filed}/reply`, { idempotency_key: 'k-res-file', feedback: '# Feedback', annotation_ids: ['res-file-1'] });

  await renderApp(`#thread=${world.filed}&file=${world.attachment}`);
  const card = () => document.querySelector(`[data-annotation-id="res-file-1"]`);
  const highlight = () => document.querySelector('[data-bind-id="res-file-1"], [data-highlight-id="res-file-1"]');
  await until(() => card() !== null && highlight() !== null, 'the sent card and its highlight');
  expect(card()!.textContent).toContain('Say more.');
  // In the document too: a box right under the paragraph it is on.
  const box = () => document.querySelector<HTMLElement>('.ib-docscroll [data-below-block="block-1"] [data-sent-comment="res-file-1"]');
  await until(() => box() !== null, 'the box under its paragraph');
  expect(box()!.closest('[data-viewer-below-block]')!.previousElementSibling!.textContent).toBe('The plan, in short.');
  expect(box()!.textContent).toContain('Say more.');

  act(() => card()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => card()?.querySelector('[data-sent-resolved]') != null, 'the Resolved chip');
  expect(card()!.textContent).not.toContain('Say more.');
  expect(card()!.querySelector('[data-sent-resolve]')!.textContent).toBe('Reopen');
  await until(() => highlight() === null, 'the highlight gone');
  // The box in the document folds with it, in place.
  await until(() => box()?.hasAttribute('data-sent-folded') === true, 'the box folded');
  expect(typeof (await storedRecord(world.filed, 'res-file-1'))?.resolved_at).toBe('string');

  act(() => card()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => highlight() !== null && card()!.textContent!.includes('Say more.'), 'the comment open again, painted');
}, 30_000);

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)("under the message, the agent's reply sits under its comment, and the person's Reply saves a draft there for the next Send", async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_reply_msg', body: 'Deploys now run at night.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('rep-msg-1', 'at night', 'Who watches it?', 'block-0') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-rep-msg', feedback: '# Feedback', annotation_ids: ['rep-msg-1'] });
  const { replied } = await command<{ replied: string }>({ commentReply: { comment: 'rep-msg-1', session: 'ses_reply_msg', text: 'The on-call person, paged.' } });

  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const thread = () => el.querySelector('[data-sent-comments] [data-sent-replies="rep-msg-1"]');
  await until(() => thread()?.querySelector(`[data-sent-reply="${replied}"]`) != null, "the agent's reply under its comment");
  expect(thread()!.textContent).toContain('Claude Code');
  expect(thread()!.textContent).toContain('The on-call person, paged.');
  // Its place is its comment's: one highlight on the message, the comment's.
  expect(el.querySelectorAll(`[data-message-id="${sent}"] [data-bind-id="${replied}"], [data-message-id="${sent}"] [data-highlight-id="${replied}"]`)).toHaveLength(0);

  act(() => el.querySelector<HTMLButtonElement>('[data-sent-comment="rep-msg-1"] [data-sent-reply-to]')!.click());
  const area = el.querySelector<HTMLTextAreaElement>('[data-sent-replies="rep-msg-1"] textarea')!;
  await type(area, 'Page me too.');
  await act(async () => {
    el.querySelector<HTMLButtonElement>('[data-sent-replies="rep-msg-1"] [data-sent-reply-save]')!.click();
  });
  await until(() => thread()?.querySelector('[data-sent-reply-draft]') != null, "the person's draft under the comment");
  expect(thread()!.querySelector('[data-sent-reply-draft]')!.textContent).toContain('Page me too.');
  expect(thread()!.querySelector('textarea')).toBeNull();
  const model = JSON.parse((await loopback(`/api/inbox/threads/${sent}/attachments`)).text) as { annotations: InboxAnnotationRecord[] };
  expect(model.annotations.map((r) => [r.re, r.annotation.text, r.sent_reply_id])).toEqual([['rep-msg-1', 'Page me too.', null]]);

  // The box saves on the comment composers' key: a plain Enter while "Enter saves a comment" is on, and ⌘/Ctrl+Enter
  // always. It takes the key (prevented): the thread's Send skips a prevented key, so ⌘/Ctrl+Enter here never sends
  // the drafts waiting under the comment.
  const replyByKey = async (words: string, init: KeyboardEventInit) => {
    act(() => el.querySelector<HTMLButtonElement>('[data-sent-comment="rep-msg-1"] [data-sent-reply-to]')!.click());
    const box = el.querySelector<HTMLTextAreaElement>('[data-sent-replies="rep-msg-1"] textarea')!;
    await type(box, words);
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    await act(async () => {
      box.dispatchEvent(key);
    });
    return key;
  };
  configStore.set('enterSavesComment', true);
  try {
    const enter = await replyByKey('And the lead.', {});
    await until(() => thread()?.querySelectorAll('[data-sent-reply-draft]').length === 2, 'the second draft, saved by Enter');
    expect(enter.defaultPrevented).toBe(true);
  } finally {
    configStore.set('enterSavesComment', false);
  }
  const chord = await replyByKey('And the backup.', { metaKey: true });
  await until(() => thread()?.querySelectorAll('[data-sent-reply-draft]').length === 3, 'the third draft, saved by ⌘Enter');
  expect(chord.defaultPrevented).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("on a file, the agent's reply is a card under its comment's, never painted, and the person replies from the sent card", async () => {
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: 'current', annotation: words('rep-file-1', 'The plan, in short.', 'Longer, please.') });
  await postJson(`/api/inbox/messages/${world.filed}/reply`, { idempotency_key: 'k-rep-file', feedback: '# Feedback', annotation_ids: ['rep-file-1'] });
  const { replied } = await command<{ replied: string }>({ commentReply: { comment: 'rep-file-1', session: 'ses_file', text: 'Added three lines.' } });
  // A reply under a comment on the version the agent sent is that version's, never in the current file's panel.
  const sha = (JSON.parse((await loopback(`/api/inbox/threads/${world.filed}/attachments`)).text) as { attachments: (InboxAttachmentState & { sent_sha256: string })[] }).attachments.find((a) => a.id === world.attachment)!.sent_sha256;
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: sha, annotation: words('rep-sent-1', 'The plan, in short.', 'On the old one.') });
  const last = JSON.parse((await loopback(`/api/inbox/threads/${world.filed}`)).text) as { thread: { messages: { id: string; author: { kind: string } }[] } };
  await postJson(`/api/inbox/messages/${last.thread.messages.filter((m) => m.author.kind === 'agent').at(-1)!.id}/reply`, { idempotency_key: 'k-rep-sent', feedback: '# Feedback', annotation_ids: ['rep-sent-1'] });
  const { replied: elsewhere } = await command<{ replied: string }>({ commentReply: { comment: 'rep-sent-1', session: 'ses_file', text: 'That version is gone.' } });

  await renderApp(`#thread=${world.filed}&file=${world.attachment}`);
  const card = (id: string) => document.querySelector(`[data-annotation-id="${id}"]`);
  await until(() => card('rep-file-1') !== null && card(replied) !== null, "the comment's card and the agent's under it");
  expect(card(replied)!.closest('[data-annotation-reply]')?.getAttribute('data-annotation-depth')).toBe('1');
  expect(card(replied)!.textContent).toContain('Added three lines.');
  // The agent's reply: no edit or delete, no Resolve of its own.
  expect([...card(replied)!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Reply']);
  expect(document.querySelector(`[data-bind-id="${replied}"], [data-highlight-id="${replied}"]`)).toBeNull();
  expect(card(elsewhere)).toBeNull();

  act(() => card('rep-file-1')!.querySelector<HTMLButtonElement>('button[aria-label="Reply"]')!.click());
  const area = document.querySelector<HTMLTextAreaElement>('[data-annotation-panel] textarea[aria-label="Reply"]')!;
  await type(area, 'Thanks, that reads well.');
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => posted.some((p) => p.path.includes('/annotations/rep-file-1/replies')), 'the reply saved under the comment');
  const draft = () =>
    [...document.querySelectorAll('[data-annotation-reply] [data-annotation-id]')].find((node) => node.textContent?.includes('Thanks, that reads well.')) ?? null;
  await until(() => draft() !== null, "the person's draft card under the comment");
  expect(draft()!.closest('[data-annotation-reply]')?.getAttribute('data-annotation-depth')).toBe('1');
}, 30_000);

/** Select `quote` in a message's words and let the mouse go there. */
async function selectIn(body: HTMLElement, quote: string) {
  const text = [...body.childNodes].find((node): node is Text => node.nodeType === 3 && (node as Text).data.includes(quote))!;
  const range = document.createRange();
  range.setStart(text, text.data.indexOf(quote));
  range.setEnd(text, text.data.indexOf(quote) + quote.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
}

/** The selection toolbar's Comment (the Inbox names its buttons by aria-label). */
const toolbarComment = () => [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].find((b) => (b.getAttribute('aria-label') ?? b.title) === 'Comment')!;

const STEPS = 'Step 1 tags the release. Step 2 rolls back through the off switch. Step 3 pages support.';

test.skipIf(!hasDom)("under the message, words selected in the agent's reply open a comment on that passage, a draft under the reply with its passage marked", async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_sub_msg', body: 'Deploys roll out to every store.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('sub-msg-1', 'every store', 'How do we roll back?', 'block-0') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-sub-msg', feedback: '# Feedback', annotation_ids: ['sub-msg-1'] });
  const { replied } = await command<{ replied: string }>({ commentReply: { comment: 'sub-msg-1', session: 'ses_sub_msg', text: STEPS } });

  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const body = () => el.querySelector<HTMLElement>(`[data-sent-reply="${replied}"] [data-passage-body="${replied}"]`);
  await until(() => body() !== null, "the agent's reply's words");

  await selectIn(body()!, 'off switch');
  await until(() => document.querySelector('[data-pn-annotation-toolbar-row]') !== null, 'the selection toolbar');
  await act(async () => {
    toolbarComment().click();
  });
  const passageBox = () => el.querySelector<HTMLElement>(`[data-sent-reply="${replied}"] [data-sent-passage-box]`);
  await until(() => passageBox() !== null, 'the box under the reply');
  expect(passageBox()!.textContent).toContain('off switch');
  await type(passageBox()!.querySelector('textarea')!, 'Which off switch?');
  await act(async () => {
    passageBox()!.querySelector<HTMLButtonElement>('[data-sent-reply-save]')!.click();
  });
  await until(() => posted.some((p) => p.path.includes(`/annotations/${replied}/subthreads`)), 'the sub-thread saved on the reply');
  const draft = () => el.querySelector(`[data-sent-reply="${replied}"] [data-sent-subthread]`);
  await until(() => draft() !== null && passageBox() === null, 'the draft sub-thread under the reply');
  expect(draft()!.textContent).toContain('Not sent');
  expect(draft()!.textContent).toContain('Which off switch?');
  expect([...body()!.querySelectorAll('mark[data-passage-mark]')].map((m) => m.textContent)).toEqual(['off switch']);
  const model = JSON.parse((await loopback(`/api/inbox/threads/${sent}/attachments`)).text) as { annotations: InboxAnnotationRecord[] };
  expect(model.annotations.map((r) => [r.parent, r.quote_offset, r.annotation.originalText, r.sent_reply_id])).toEqual([[replied, STEPS.indexOf('off switch'), 'off switch', null]]);
  // Its place is its thread's: nothing new painted on the message.
  expect(el.querySelectorAll(`[data-message-id="${sent}"] [data-bind-id="${model.annotations[0]!.id}"], [data-message-id="${sent}"] [data-highlight-id="${model.annotations[0]!.id}"]`)).toHaveLength(0);

  // Its own Send sends it alone, at once, as a comment send (the server words it for the agent, with the words its
  // passage is in); no reply of the person's is written.
  const id = model.annotations[0]!.id;
  await act(async () => {
    draft()!.querySelector<HTMLButtonElement>(`[data-sent-send="${id}"]`)!.click();
  });
  await until(() => posted.some((p) => p.path.endsWith('/comment-sends')), 'the send');
  expect(posted.find((p) => p.path.endsWith('/comment-sends'))!.body).toMatchObject({ mode: 'now', comment_ids: [id] });
  await until(() => draft()?.hasAttribute('data-sent-draft') === false, 'the sub-thread sent');
  expect(draft()!.querySelector('[data-sent-status="pending"]')).not.toBeNull();
  expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(false);
  const [carried] = (JSON.parse((await loopback(`/api/inbox/threads/${sent}/attachments`)).text) as { comment_sends: { comments: string[]; mode: string }[] }).comment_sends;
  expect([carried!.mode, carried!.comments]).toEqual(['now', [id]]);
}, 30_000);

test.skipIf(!hasDom)('with comment sends, a reply under a live thread goes on its own and shows sent; Finish round with nothing else to send ends the round alone', async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_live_msg', body: 'Deploys roll out to every store.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('live-1', 'every store', 'Lyon first.', 'block-0') });

  const el = await renderApp(`#thread=${sent}`);
  const box = () => el.querySelector<HTMLElement>('[data-sent-comments] [data-sent-comment="live-1"]');
  await until(() => box()?.querySelector('[data-sent-send="live-1"]') != null, "the draft's Send");
  await act(async () => {
    box()!.querySelector<HTMLButtonElement>('[data-sent-send="live-1"]')!.click();
  });
  await until(() => box()?.querySelector('[data-sent-live]') != null, 'the thread live');
  // No draft left, but a send went in the round under way: Finish round is still offered.
  expect(el.querySelector('[data-finish-round]')).not.toBeNull();

  // The person's reply under it goes on its own: sent (Queued), never "Not sent".
  act(() => box()!.querySelector<HTMLButtonElement>('[data-sent-reply-to="live-1"]')!.click());
  await type(box()!.querySelector<HTMLTextAreaElement>('[data-sent-replies="live-1"] textarea')!, 'And Nantes.');
  await act(async () => {
    box()!.querySelector<HTMLButtonElement>('[data-sent-reply-save]')!.click();
  });
  const reply = () => [...(box()?.querySelectorAll<HTMLElement>('[data-sent-reply]') ?? [])].find((row) => row.textContent?.includes('And Nantes.'));
  await until(() => reply()?.querySelector('[data-sent-status="pending"]') != null, 'the reply sent on its own');
  expect(reply()!.hasAttribute('data-sent-reply-draft')).toBe(false);
  expect(posted.filter((p) => p.path.endsWith('/comment-sends'))).toHaveLength(1);

  // Finish round alone (no words, no draft): one round send, no reply of the person's.
  act(() => el.querySelector<HTMLButtonElement>('[data-finish-round]')!.click());
  await until(() => posted.filter((p) => p.path.endsWith('/comment-sends')).length === 2, 'the Finish');
  expect(posted.filter((p) => p.path.endsWith('/comment-sends')).at(-1)!.body).toMatchObject({ mode: 'round' });
  expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(false);
  await until(() => el.querySelector('[data-comment-rounds]')?.textContent === 'Round 2 · 1 open', 'round 2 under way');
  expect(el.querySelector('[data-finish-round]')).toBeNull();
}, 30_000);

test.skipIf(!hasDom)("with comment sends, a draft comment on a file has Send on its card's foot: it goes alone, and the card says what became of it", async () => {
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: 'current', annotation: words('snd-file-1', 'The plan, in short.', 'Shorter, please.') });

  await renderApp(`#thread=${world.filed}&file=${world.attachment}`);
  const card = () => document.querySelector<HTMLElement>('[data-annotation-id="snd-file-1"]');
  await until(() => card()?.querySelector('[data-sent-send="snd-file-1"]') != null, "the draft card's Send");
  await act(async () => {
    card()!.querySelector<HTMLButtonElement>('[data-sent-send="snd-file-1"]')!.click();
  });
  await until(() => posted.some((p) => p.path.endsWith('/comment-sends')), 'the send');
  expect(posted.find((p) => p.path.endsWith('/comment-sends'))!.body).toMatchObject({ mode: 'now', comment_ids: ['snd-file-1'] });
  await until(() => card()?.querySelector('[data-sent-status="pending"]') != null, 'the sent card, Queued');
  expect(card()!.querySelector('[data-sent-send]')).toBeNull();
  expect(card()!.querySelector('[data-sent-round="1"]')).not.toBeNull();
}, 30_000);

test.skipIf(!hasDom)("with comment sends, a draft comment is a box with Send that goes alone; the words' Send carries no draft; Finish round sends the rest with the words, and the header counts the round", async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_sends_msg', body: 'Deploys roll out to every store, then we watch sales.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('snd-d1', 'every store', 'Lyon first.', 'block-0') });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('snd-d2', 'watch sales', 'Who watches?', 'block-0') });

  const el = await renderApp(`#thread=${sent}`);
  const box = (id: string) => el.querySelector<HTMLElement>(`[data-sent-comments] [data-sent-comment="${id}"]`);
  await until(() => box('snd-d1') !== null && box('snd-d2') !== null, 'the drafts drawn as boxes under their passage');
  expect(box('snd-d1')!.hasAttribute('data-sent-draft')).toBe(true);
  expect(box('snd-d1')!.closest('[data-viewer-below-block]')!.getAttribute('data-below-block')).toBe('block-0');
  // Nothing sent yet: no count; Finish round is offered (drafts wait), the closed foot has no Send for them alone.
  expect(el.querySelector('[data-comment-rounds]')).toBeNull();
  expect(el.querySelector('[data-finish-round]')).not.toBeNull();
  const messages = async () => (JSON.parse((await loopback(`/api/inbox/threads/${sent}`)).text) as { thread: { messages: { id: string; author: { kind: string }; body: string }[] } }).thread.messages;
  const before = (await messages()).length;

  // Send on one draft: it goes alone, at once; the other waits; no message in the thread; the header counts round 1.
  await act(async () => {
    box('snd-d1')!.querySelector<HTMLButtonElement>('[data-sent-send="snd-d1"]')!.click();
  });
  await until(() => box('snd-d1')?.hasAttribute('data-sent-draft') === false, 'the first draft sent');
  expect(posted.filter((p) => p.path.endsWith('/comment-sends')).map((p) => [p.body.mode, p.body.comment_ids])).toEqual([['now', ['snd-d1']]]);
  expect(box('snd-d1')!.querySelector('[data-sent-status="pending"]')).not.toBeNull();
  expect(box('snd-d2')!.hasAttribute('data-sent-draft')).toBe(true);
  expect((await messages()).length).toBe(before);
  await until(() => el.querySelector('[data-comment-rounds]')?.textContent === 'Round 1 · 1 open', 'the count');

  // The words' Send carries the words only: no draft, no feedback text; the draft still waits.
  act(() => el.querySelector<HTMLButtonElement>('[data-reply-button]')!.click());
  const field = () => el.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Reply to"]');
  await until(() => field() !== null, 'the reply box');
  await type(field()!, 'Ship it after the second store.');
  const sendButton = () => [...el.querySelectorAll<HTMLButtonElement>('[data-reply-row] button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Send');
  act(() => sendButton()!.click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  const words1 = posted.find((p) => p.path.endsWith('/reply'))!.body;
  expect([words1.words, words1.annotation_ids, words1.feedback]).toEqual(['Ship it after the second store.', undefined, undefined]);
  await until(() => field() === null, 'the box closed');
  expect(box('snd-d2')!.hasAttribute('data-sent-draft')).toBe(true);

  // Finish round with words: they go as the person's reply, the round's end written with it (one request) with the draft left.
  act(() => el.querySelector<HTMLButtonElement>('[data-reply-button]')!.click());
  await until(() => field() !== null, 'the reply box again');
  await type(field()!, 'That is all for this round.');
  act(() => el.querySelector<HTMLButtonElement>('[data-reply-row] [data-finish-round]')!.click());
  await until(() => posted.filter((p) => p.path.endsWith('/reply')).length === 2, 'the Finish with the words');
  const finishing = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!.body;
  expect([finishing.words, typeof (finishing.finish_round as { idempotency_key?: unknown })?.idempotency_key]).toEqual(['That is all for this round.', 'string']);
  expect(posted.filter((p) => p.path.endsWith('/comment-sends'))).toHaveLength(1);
  const last = (await messages()).at(-1)!;
  const sendsNow = (JSON.parse((await loopback(`/api/inbox/threads/${sent}/attachments`)).text) as { comment_sends: { mode: string; comments: string[]; with_message: string | null }[] }).comment_sends;
  expect([last.author.kind, last.body]).toEqual(['person', 'That is all for this round.']);
  // It carries the draft left and names the thread still open.
  expect(sendsNow.at(-1)).toMatchObject({ mode: 'round', comments: ['snd-d2', 'snd-d1'], with_message: last.id });
  await until(() => box('snd-d2')?.hasAttribute('data-sent-draft') === false, 'the last draft sent by the Finish');
  await until(() => el.querySelector('[data-comment-rounds]')?.textContent === 'Round 2 · 2 open', 'round 2 under way');
  // Nothing left and nothing sent in round 2: no Finish round to offer.
  expect(el.querySelector('[data-finish-round]')).toBeNull();
}, 40_000);

test.skipIf(!hasDom)('a resolved comment stays unfolded, marked Resolved, while a sub-thread under it is open; resolving that one too folds both', async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_sub_res', body: 'Deploys roll out to every store.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('sub-res-1', 'every store', 'How do we roll back?', 'block-0') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-sub-res', feedback: '# Feedback', annotation_ids: ['sub-res-1'] });
  const { replied } = await command<{ replied: string }>({ commentReply: { comment: 'sub-res-1', session: 'ses_sub_res', text: STEPS } });
  await postJson(`/api/inbox/annotations/${replied}/subthreads`, { annotation: { id: 'sub-res-s', text: 'Which off switch?', quote: 'off switch', quote_offset: STEPS.indexOf('off switch') } });
  const last = JSON.parse((await loopback(`/api/inbox/threads/${sent}`)).text) as { thread: { messages: { id: string; author: { kind: string } }[] } };
  await postJson(`/api/inbox/messages/${last.thread.messages.filter((m) => m.author.kind === 'agent').at(-1)!.id}/reply`, { idempotency_key: 'k-sub-res-2', feedback: '# Feedback on comment threads', annotation_ids: ['sub-res-s'] });

  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const row = () => el.querySelector<HTMLElement>('[data-sent-comments] [data-sent-comment="sub-res-1"]');
  const sub = () => el.querySelector<HTMLElement>('[data-sent-comments] [data-sent-comment="sub-res-s"]');
  await until(() => row() !== null && sub() !== null, 'the comment and its sub-thread');
  expect(sub()!.querySelector('[data-sent-round="2"]')).not.toBeNull();

  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-resolve="sub-res-1"]')!.click());
  await until(() => row()?.hasAttribute('data-sent-resolved') === true, 'the comment resolved');
  // Unfolded, marked Resolved: its words, its reply, its open sub-thread (a box in its box), and Reopen.
  expect(row()!.hasAttribute('data-sent-folded')).toBe(false);
  expect(row()!.querySelector('[data-sent-resolved-chip]')).not.toBeNull();
  expect(row()!.textContent).toContain('How do we roll back?');
  expect(row()!.contains(sub())).toBe(true);
  expect(sub()!.parentElement!.closest('[data-sent-reply]')).not.toBeNull();
  expect(row()!.querySelector('[data-sent-resolve="sub-res-1"]')!.textContent).toBe('Reopen');

  act(() => sub()!.querySelector<HTMLButtonElement>('[data-sent-resolve="sub-res-s"]')!.click());
  await until(() => row()?.hasAttribute('data-sent-folded') === true, 'both folded');
  expect(sub()).toBeNull();
  expect(row()!.querySelector('[data-sent-subthreads]')!.getAttribute('data-sent-subthreads')).toBe('1');
  expect(typeof (await storedRecord(sent, 'sub-res-s'))?.resolved_at).toBe('string');

  // Opened to be read, the sub-thread is folded too; the comment keeps its Reply: a reply under it opens it again.
  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-unfold="sub-res-1"]')!.click());
  await until(() => sub()?.hasAttribute('data-sent-folded') === true, 'the sub-thread folded inside');
  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-reply-to="sub-res-1"]')!.click());
  const area = () => el.querySelector<HTMLTextAreaElement>('[data-sent-replies="sub-res-1"] textarea');
  await until(() => area() !== null, 'the box under the resolved comment');
  await type(area()!, 'One more thing.');
  await act(async () => {
    el.querySelector<HTMLButtonElement>('[data-sent-replies="sub-res-1"] [data-sent-reply-save]')!.click();
  });
  await until(() => row() !== null && !row()!.hasAttribute('data-sent-resolved'), 'the comment open again');
}, 30_000);

test.skipIf(!hasDom)("on a file, words selected in a sent card open a comment on that passage, a draft card under it", async () => {
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: 'current', annotation: words('sub-file-1', 'The plan, in short.', 'Say more about the rollback, please.') });
  await postJson(`/api/inbox/messages/${world.filed}/reply`, { idempotency_key: 'k-sub-file', feedback: '# Feedback', annotation_ids: ['sub-file-1'] });

  await renderApp(`#thread=${world.filed}&file=${world.attachment}`);
  const body = () => document.querySelector<HTMLElement>('[data-annotation-id="sub-file-1"] [data-passage-body="sub-file-1"]');
  await until(() => body() !== null, "the sent card's words");
  await selectIn(body()!, 'the rollback');
  await until(() => document.querySelector('[data-pn-annotation-toolbar-row]') !== null, 'the selection toolbar');
  await act(async () => {
    toolbarComment().click();
  });
  const area = () => document.querySelector<HTMLTextAreaElement>('[data-annotation-panel] textarea[aria-label="Comment on passage"]');
  await until(() => area() !== null, 'the box under the card');
  await type(area()!, 'Which rollback?');
  await act(async () => {
    area()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => posted.some((p) => p.path.includes('/annotations/sub-file-1/subthreads')), 'the sub-thread saved on the card');
  const draft = () => [...document.querySelectorAll('[data-annotation-reply] [data-annotation-id]')].find((node) => node.textContent?.includes('Which rollback?')) ?? null;
  await until(() => draft() !== null, 'the draft card under the comment');
  expect(draft()!.closest('[data-annotation-reply]')?.getAttribute('data-annotation-depth')).toBe('1');
  // Its passage is at its head, and marked in the comment's words.
  expect(draft()!.textContent).toContain('"the rollback"');
  expect([...body()!.querySelectorAll('mark[data-passage-mark]')].map((m) => m.textContent)).toEqual(['the rollback']);
  // Never painted on the file.
  const id = draft()!.getAttribute('data-annotation-id')!;
  expect(document.querySelector(`[data-bind-id="${id}"], [data-highlight-id="${id}"]`)).toBeNull();
}, 30_000);
