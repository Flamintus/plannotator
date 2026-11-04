/**
 * A message holding a comment thread still open opens unfolded in its thread
 * (experimental "persistent-comments"; sentComments.ts `unfoldOpenThreads`):
 * the whole window (InboxApp) over a REAL Inbox in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts), the switch saved through
 * Settings so each test turns it on or off. What is proved: on a reload, an
 * earlier message whose thread is open is neither folded nor behind "N
 * earlier messages", its thread in view; with the thread resolved (nothing
 * open under it), or with the switch off, it folds as every read message
 * does.
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-open-threads-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '4'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
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

/** A comment on selected words of a one-paragraph message, as the window's viewer makes it. */
function words(id: string, originalText: string, text: string) {
  return { id, blockId: 'block-0', startOffset: 0, endOffset: originalText.length, type: 'COMMENT', text, originalText, createdA: 1 };
}

async function switchTo(on: boolean) {
  await postJson('/api/inbox/settings', { experimental: { persistent_comments: on } });
}

/**
 * A thread read up to its last message: A0, the person's R0, A1 (a comment on
 * it, sent with R1), A2, R2, A3. Six read messages before the last: all fold,
 * and the middle three (R0, A1, R1) wait behind "3 earlier messages".
 */
async function longThread(tag: string): Promise<{ thread: string; commented: string; comment: string }> {
  const session = `ses_open_${tag}`;
  const { sent: a0 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Step zero is done.' } });
  await postJson(`/api/inbox/messages/${a0}/reply`, { idempotency_key: `${tag}-r0`, words: 'Go on.' });
  const { sent: a1 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Deploys roll out to every store.', reply_to: a0 } });
  const comment = `${tag}-c1`;
  await postJson(`/api/inbox/messages/${a1}/annotations`, { annotation: words(comment, 'every store', 'How do we roll back?') });
  await postJson(`/api/inbox/messages/${a1}/reply`, { idempotency_key: `${tag}-r1`, feedback: '# Feedback', annotation_ids: [comment] });
  const { sent: a2 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Noted, a rollback switch.', reply_to: a0 } });
  await postJson(`/api/inbox/messages/${a2}/reply`, { idempotency_key: `${tag}-r2`, words: 'Fine.' });
  await command<{ sent: string }>({ send: { project: world.project, session, body: 'All done.', reply_to: a0 } });
  return { thread: a0, commented: a1, comment };
}

const articleOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-message-article="${id}"]`);

test.skipIf(!hasDom)('switch on: an earlier message whose thread is open opens unfolded, out of "N earlier messages", its thread in view', async () => {
  await switchTo(true);
  const { thread, commented, comment } = await longThread('on');
  const el = await renderApp(`#thread=${thread}`);
  await until(() => el.querySelector(`[data-sent-comment="${comment}"]`) !== null, 'the open thread in view');
  expect(articleOf(el, commented)!.hasAttribute('data-folded')).toBe(false);
  // The other read messages fold as before: the first, and the run's ends.
  expect(articleOf(el, thread)!.hasAttribute('data-folded')).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('switch on: an earlier message whose thread is resolved, nothing open under it, folds as before', async () => {
  await switchTo(true);
  const { thread, commented, comment } = await longThread('done');
  await postJson(`/api/inbox/annotations/${comment}/resolve`, { resolved: true });
  const el = await renderApp(`#thread=${thread}`);
  await until(() => el.querySelector('[data-middle-fold]') !== null, 'the folded run');
  await settle();
  expect(articleOf(el, commented)).toBeNull();
  expect(el.querySelector('[data-middle-fold]')!.textContent).toContain('3 earlier messages');
}, 30_000);

test.skipIf(!hasDom)('switch off: the message with the comment folds behind "N earlier messages" as before', async () => {
  await switchTo(false);
  const { thread, commented } = await longThread('off');
  const el = await renderApp(`#thread=${thread}`);
  await until(() => el.querySelector('[data-middle-fold]') !== null, 'the folded run');
  await settle();
  expect(articleOf(el, commented)).toBeNull();
  expect(el.querySelector('[data-middle-fold]')!.textContent).toContain('3 earlier messages');
  expect(el.querySelector('[data-sent-comments]')).toBeNull();
}, 30_000);
