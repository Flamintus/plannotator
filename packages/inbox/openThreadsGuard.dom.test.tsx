/**
 * A comment thread still open holds the thread's Archive, as the window shows
 * it (a personal branch, own/open-threads-guard): the whole window (InboxApp)
 * over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts), with sent comments kept in view turned
 * on or off through Settings' own route. What is proved: while a sent
 * comment is open, the thread header's ⋯ Archive item says how many comment
 * threads are still open, and its press leads to the oldest (its row under
 * the agent's message, or a file's card) and archives nothing; once it is
 * resolved the item archives as before; with the switch off it always does.
 * The server side is proved in packages/server/inbox-open-threads-guard.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
let posted: string[] = [];

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-open-threads-guard-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  // The switch is Settings' to turn (config.json): an env var would decide it instead.
  const { PLANNOTATOR_EXPERIMENTAL: _decides, ...env } = process.env;
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '4'], {
    env: { ...env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
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
    if (method === 'POST') posted.push(path);
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
  return host;
}

const keepSentComments = (on: boolean) => postJson('/api/inbox/settings', { experimental: { persistent_comments: on } });

function words(id: string, originalText: string, text: string) {
  return { id, blockId: 'block-1', startOffset: 0, endOffset: originalText.length, type: 'COMMENT', text, originalText, createdA: 1 };
}

/** An agent's message with one comment on its words, sent in the person's reply. */
async function commentedMessage(session: string, id: string): Promise<string> {
  const { sent } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Retries now back off for a minute at most.' } });
  await postJson(`/api/inbox/messages/${sent}/annotations`, { annotation: words(id, 'a minute at most', 'Why a minute?') });
  await postJson(`/api/inbox/messages/${sent}/reply`, { idempotency_key: `k-${id}`, feedback: '# Feedback', annotation_ids: [id] });
  return sent;
}

/** Base UI opens a menu on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
}

/** The header's ⋯ opened; its Archive item. */
async function archiveItem(el: HTMLElement): Promise<HTMLElement> {
  await until(() => el.querySelector('section.ib-pane [data-thread-more]') !== null, 'the header ⋯');
  await press(el.querySelector<HTMLElement>('section.ib-pane [data-thread-more]')!);
  await until(() => document.querySelector('[data-thread-menu] [data-thread-archive-item]') !== null, 'the Archive item in the ⋯ menu');
  return document.querySelector<HTMLElement>('[data-thread-menu] [data-thread-archive-item]')!;
}

const archivedFoot = (el: HTMLElement) => el.textContent?.includes('Archived. The next message from') ?? false;
const storedArchived = async (thread: string) => (JSON.parse((await loopback(`/api/inbox/threads/${thread}`)).text) as { thread: { resolved_at: string | null } }).thread.resolved_at !== null;

test.skipIf(!hasDom)("on: while a sent comment is open, Archive says so and leads to its row under the message, archiving nothing; resolved, it archives", async () => {
  await keepSentComments(true);
  const sent = await commentedMessage('ses_guard_msg', 'guard-msg-1');
  const el = await renderApp(`#thread=${sent}`);
  const row = () => el.querySelector<HTMLElement>(`[data-sent-comments] [data-sent-comment="guard-msg-1"]`);
  // The message folds once answered: the item unfolds it to bring the row into view.
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');

  const held = await archiveItem(el);
  expect(held.getAttribute('data-thread-archive-held')).toBe('1');
  expect(held.textContent).toContain('1 comment thread still open');
  await act(async () => held.click());
  await until(() => row()?.classList.contains('ib-q-target') === true, 'the open comment rung under its message');
  expect(posted.some((path) => path.includes(`${sent}/resolve`))).toBe(false);
  expect(archivedFoot(el)).toBe(false);
  expect(await storedArchived(sent)).toBe(false);

  act(() => row()!.querySelector<HTMLButtonElement>('[data-sent-resolve]')!.click());
  await until(() => row() === null, 'the comment resolved and folded');
  const item = await archiveItem(el);
  expect(item.hasAttribute('data-thread-archive-held')).toBe(false);
  expect(item.textContent).toContain('Archive thread');
  await act(async () => item.click());
  await until(() => archivedFoot(el), 'the archived foot');
  expect(await storedArchived(sent)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)("on: an open comment on a file holds it too, and the item opens the file at its card", async () => {
  await keepSentComments(true);
  await postJson('/api/inbox/annotations', { attachment_id: world.attachment, version: 'current', annotation: words('guard-file-1', 'The plan, in short.', 'Say more.') });
  await postJson(`/api/inbox/messages/${world.filed}/reply`, { idempotency_key: 'k-guard-file', feedback: '# Feedback', annotation_ids: ['guard-file-1'] });
  const el = await renderApp(`#thread=${world.filed}`);
  const card = () => document.querySelector(`[data-annotation-id="guard-file-1"]`);
  expect(card()).toBeNull();

  const held = await archiveItem(el);
  expect(held.textContent).toContain('1 comment thread still open');
  await act(async () => held.click());
  await until(() => card() !== null, "the file open at the comment's card");
  expect(await storedArchived(world.filed)).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('off: Archive archives the thread, open comments or not', async () => {
  await keepSentComments(false);
  const sent = await commentedMessage('ses_guard_off', 'guard-off-1');
  const el = await renderApp(`#thread=${sent}`);
  await until(() => el.querySelector(`[data-message-article="${sent}"]`) !== null, 'the thread');
  const item = await archiveItem(el);
  expect(item.hasAttribute('data-thread-archive-held')).toBe(false);
  expect(item.textContent).toContain('Archive thread');
  await act(async () => item.click());
  await until(() => archivedFoot(el), 'the archived foot');
  expect(await storedArchived(sent)).toBe(true);
}, 30_000);
