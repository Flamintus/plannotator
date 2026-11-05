/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the whole window (InboxApp) over a REAL Inbox in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts) started with
 * PLANNOTATOR_EXPERIMENTAL=persistent-comments. What is proved: a comment on
 * an agent's message, once sent, stays highlighted and is listed under the
 * message with its round; a comment on a file, once sent, stays in the file's
 * panel with its round and without edit or delete, and when the agent's edit
 * took its words away the window shows it Unanchored and keeps that in the
 * store; and the person resolves a sent comment, from under the message or
 * from its card, and opens it again: resolved, it leaves the highlights and
 * folds, and the store keeps it; and replies sit under a sent comment, the
 * agent's and the person's (a draft until the next Send), under the message
 * and on the file's card, never painted. The server side is proved in
 * packages/server/inbox-persistent-comments.test.ts and
 * inbox-comment-replies.test.ts.
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
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '6'], {
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

/** A comment on selected words, as the window's viewer makes it. */
function words(id: string, originalText: string, text: string) {
  return { id, blockId: 'block-1', startOffset: 0, endOffset: originalText.length, type: 'COMMENT', text, originalText, createdA: 1 };
}

test.skipIf(!hasDom)("a sent comment on an agent's message stays highlighted, and is listed under the message with its round", async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_sent_msg', body: 'The backoff is now two, four and eight seconds.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('sent-msg-1', 'two, four and eight seconds', 'Cap the total wait.') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-msg', feedback: '# Feedback', annotation_ids: ['sent-msg-1'] });

  const el = await renderApp(`#thread=${sent}`);
  // A message the person answered may open folded: its sent comments are in its body.
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const row = () => el.querySelector(`[data-sent-comments] [data-sent-comment="sent-msg-1"]`);
  await until(() => row() !== null, 'the sent comment under the message');
  expect(row()!.querySelector('[data-sent-round="1"]')).not.toBeNull();
  expect(row()!.textContent).toContain('Cap the total wait.');
  await until(() => el.querySelector(`[data-message-id="${sent}"] [data-bind-id="sent-msg-1"], [data-message-id="${sent}"] [data-highlight-id="sent-msg-1"]`) !== null, "the sent comment's highlight");
  // Its words are there: nothing to keep.
  expect(posted.some((p) => p.path.includes('/unanchored'))).toBe(false);
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

test.skipIf(!hasDom)("resolved under the message, a sent comment leaves its words and waits behind \"1 resolved\"; Reopen brings it back", async () => {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_resolve_msg', body: 'Retries now back off for a minute at most.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('res-msg-1', 'a minute at most', 'Why a minute?') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: 'k-res-msg', feedback: '# Feedback', annotation_ids: ['res-msg-1'] });

  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const article = el.querySelector<HTMLElement>(`[data-message-article="${sent}"]`)!;
  if (article.hasAttribute('data-folded')) act(() => article.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const row = () => el.querySelector(`[data-sent-comments] [data-sent-comment="res-msg-1"]`);
  const highlight = () => el.querySelector(`[data-message-id="${sent}"] [data-bind-id="res-msg-1"], [data-message-id="${sent}"] [data-highlight-id="res-msg-1"]`);
  await until(() => row() !== null && highlight() !== null, 'the sent comment and its highlight');

  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => row() === null && highlight() === null, 'the resolved comment folded away');
  const toggle = el.querySelector<HTMLButtonElement>('[data-sent-comments] [data-sent-resolved-toggle]')!;
  // The toggle names how many wait behind it.
  expect(toggle.textContent).toContain('1');
  expect(typeof (await storedRecord(sent, 'res-msg-1'))?.resolved_at).toBe('string');

  act(() => toggle.click());
  await until(() => row()?.hasAttribute('data-sent-resolved') === true, 'the resolved row shown');
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

  act(() => card()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => card()?.querySelector('[data-sent-resolved]') != null, 'the Resolved chip');
  expect(card()!.textContent).not.toContain('Say more.');
  expect(card()!.querySelector('[data-sent-resolve]')!.textContent).toBe('Reopen');
  await until(() => highlight() === null, 'the highlight gone');
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
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words('rep-msg-1', 'at night', 'Who watches it?') });
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

  // The box saves on the comment composers' key: with "Enter saves a comment" on, a plain Enter. The key is taken
  // (prevented), so the thread's Send, which skips a prevented key, never sends the draft waiting under the comment.
  configStore.set('enterSavesComment', true);
  try {
    act(() => el.querySelector<HTMLButtonElement>('[data-sent-comment="rep-msg-1"] [data-sent-reply-to]')!.click());
    const again = el.querySelector<HTMLTextAreaElement>('[data-sent-replies="rep-msg-1"] textarea')!;
    await type(again, 'And the lead.');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      again.dispatchEvent(enter);
    });
    await until(() => thread()?.querySelectorAll('[data-sent-reply-draft]').length === 2, 'the second draft, saved by the key');
    expect(enter.defaultPrevented).toBe(true);
  } finally {
    configStore.set('enterSavesComment', false);
  }
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
