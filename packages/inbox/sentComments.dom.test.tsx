/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the whole window (InboxApp) over a REAL Inbox in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts) started with
 * PLANNOTATOR_EXPERIMENTAL=persistent-comments. What is proved: a comment on
 * an agent's message, once sent, stays highlighted and is listed under the
 * message with its round; a comment on a file, once sent, stays in the file's
 * panel with its round and without edit or delete, and when the agent's edit
 * took its words away the window shows it Unanchored and keeps that in the
 * store. The server side is proved in packages/server/inbox-persistent-comments.test.ts.
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
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '2'], {
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
  expect(card()!.querySelectorAll('button').length).toBe(0);
  await until(() => card()!.querySelector('[data-annotation-unanchored]') !== null, 'the Unanchored chip');
  await until(() => posted.some((p) => p.path.includes('/annotations/sent-file-1/unanchored') && p.body.unanchored === true), 'the unanchored mark sent');
  await until(async () => {
    const after = JSON.parse((await loopback(`/api/inbox/threads/${world.filed}/attachments`)).text) as { sent_comments: InboxAnnotationRecord[] };
    return typeof after.sent_comments.find((r) => r.id === 'sent-file-1')?.unanchored_at === 'string';
  }, 'the mark kept in the store');
}, 30_000);
