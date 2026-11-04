/**
 * The thread kept for the conversation (experimental "persistent-comments";
 * roundLines.ts, components/RoundLine.tsx): the whole window (InboxApp) over
 * a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts), the switch saved through Settings so
 * each test turns it on or off. What is proved:
 *  - a Send whose comments live in their boxes is one line in place of the
 *    message, and a press shows the text the agent got; the last Send keeps
 *    its delivery line;
 *  - a Send with the person's words keeps them, its boxed feedback folded
 *    into one line under them (the open threads sent again counted);
 *  - an agent's message with no body is one line, its reply in the box;
 *  - with the lines in the thread, an earlier message holding an open thread
 *    still opens unfolded, its box in view;
 *  - with the switch off, a Send is drawn as before.
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
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { messageFeedback } from './attachments';

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-round-lines-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '5'], {
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
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
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

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
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

/** The person's comment on an agent's message, and the feedback the window's Send writes for it (`messageFeedback`). */
async function commentOn(messageId: string, id: string, quote: string, text: string): Promise<string> {
  const { annotation } = await postJson(`/api/inbox/messages/${messageId}/annotations`, { annotation: words(id, quote, text) });
  return messageFeedback([annotation as InboxAnnotationRecord]);
}

const articleOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-message-article="${id}"]`);

async function press(button: HTMLElement) {
  await act(async () => {
    button.click();
  });
}

test.skipIf(!hasDom)('switch on: a Send of comments alone is one line in place of the message; a press shows what the agent got', async () => {
  await switchTo(true);
  const { sent: a0 } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_round_alone', body: 'Deploys roll out to every store.' } });
  const feedback = await commentOn(a0, 'alone-c1', 'every store', 'How do we roll back?');
  const { reply } = await postJson(`/api/inbox/messages/${a0}/reply`, { idempotency_key: 'alone-r1', feedback, annotation_ids: ['alone-c1'] });
  const el = await renderApp(`#thread=${a0}`);
  await until(() => articleOf(el, reply.id)?.getAttribute('data-round-line') === 'round', 'the round line');
  const line = articleOf(el, reply.id)!;
  expect(line.querySelector('[data-round-words]')!.textContent).toBe('Round 1 · 1 comment sent');
  // The comment lives in its box under the agent's message; the Send's text waits behind the line.
  expect(el.querySelector('[data-sent-comment="alone-c1"]')).not.toBeNull();
  expect(line.querySelector('[data-reply-feedback]')).toBeNull();
  // The last Send still says where it is on its way to the agent.
  expect(line.querySelector('[data-delivery]')).not.toBeNull();
  const row = line.querySelector<HTMLButtonElement>('[data-round-row]')!;
  expect(row.getAttribute('aria-expanded')).toBe('false');
  await press(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(line.querySelector('[data-reply-feedback]')!.textContent).toContain('How do we roll back?');
  await press(row);
  expect(line.querySelector('[data-reply-feedback]')).toBeNull();
}, 30_000);

test.skipIf(!hasDom)("switch on: a Send with the person's words keeps them, its comments folded into one line under them", async () => {
  await switchTo(true);
  const { sent: a0 } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_round_words', body: 'Deploys roll out to every store.' } });
  const feedback = await commentOn(a0, 'words-c1', 'every store', 'How do we roll back?');
  const { reply } = await postJson(`/api/inbox/messages/${a0}/reply`, { idempotency_key: 'words-r1', words: 'Lyon first, then the rest.', feedback, annotation_ids: ['words-c1'] });
  const el = await renderApp(`#thread=${a0}`);
  await until(() => articleOf(el, reply.id)?.querySelector('[data-round-fold]') != null, 'the folded feedback');
  const message = articleOf(el, reply.id)!;
  expect(message.hasAttribute('data-round-line')).toBe(false);
  expect(message.textContent).toContain('Lyon first, then the rest.');
  expect(message.querySelector('[data-round-fold] [data-round-words]')!.textContent).toBe('Round 1 · 1 comment sent');
  expect(message.textContent).not.toContain('How do we roll back?');
  await press(message.querySelector<HTMLButtonElement>('[data-round-fold] button')!);
  expect(message.querySelector('[data-round-fold] [data-reply-feedback]')!.textContent).toContain('How do we roll back?');
}, 30_000);

test.skipIf(!hasDom)("switch on: an agent's message with no body is one line, its reply in the box under the comment", async () => {
  await switchTo(true);
  const session = 'ses_round_replies';
  const { sent: a0 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Deploys roll out to every store.' } });
  const feedback = await commentOn(a0, 'replies-c1', 'every store', 'How do we roll back?');
  await postJson(`/api/inbox/messages/${a0}/reply`, { idempotency_key: 'replies-r1', feedback, annotation_ids: ['replies-c1'] });
  const { sent: a1 } = await command<{ sent: string }>({ commentReply: { comment: 'replies-c1', session, text: 'Through the feature-flag switch.', body: '' } });
  const el = await renderApp(`#thread=${a0}`);
  await until(() => articleOf(el, a1)?.getAttribute('data-round-line') === 'replies', 'the replies line');
  const line = articleOf(el, a1)!;
  expect(line.querySelector('[data-round-words]')!.textContent).toBe('Replied under 1 comment');
  // No empty message body, and nothing to open.
  expect(line.querySelector('.ib-body')).toBeNull();
  expect(line.querySelector('button[data-round-row]')).toBeNull();
  await until(() => el.querySelector('[data-sent-comment="replies-c1"]')?.textContent?.includes('Through the feature-flag switch.') === true, 'the reply in its box');
}, 30_000);

test.skipIf(!hasDom)('switch on: with round lines in a long thread, an earlier message holding an open thread still opens, its box in view', async () => {
  await switchTo(true);
  const session = 'ses_round_long';
  const { sent: a0 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Step zero is done.' } });
  await postJson(`/api/inbox/messages/${a0}/reply`, { idempotency_key: 'long-r0', words: 'Go on.' });
  const { sent: a1 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Deploys roll out to every store.', reply_to: a0 } });
  const feedback = await commentOn(a1, 'long-c1', 'every store', 'How do we roll back?');
  await postJson(`/api/inbox/messages/${a1}/reply`, { idempotency_key: 'long-r1', feedback, annotation_ids: ['long-c1'] });
  await command<{ sent: string }>({ commentReply: { comment: 'long-c1', session, text: 'Through the feature-flag switch.', body: '' } });
  const { sent: a3 } = await command<{ sent: string }>({ send: { project: world.project, session, body: 'Noted.', reply_to: a0 } });
  // Round 2: the person's words; the store sends the comment still open again.
  const { reply: last } = await postJson(`/api/inbox/messages/${a3}/reply`, { idempotency_key: 'long-r2', words: 'Fine, go on.' });
  const el = await renderApp(`#thread=${a0}`);
  await until(() => el.querySelector('[data-sent-comment="long-c1"]') !== null, 'the open thread in view');
  expect(articleOf(el, a1)!.hasAttribute('data-folded')).toBe(false);
  // The last Send keeps its words; the open thread it sent again is its line.
  const message = articleOf(el, last.id)!;
  expect(message.textContent).toContain('Fine, go on.');
  expect(message.querySelector('[data-round-fold] [data-round-words]')!.textContent).toBe('1 open thread sent again');
  // No message of the thread is drawn as an empty body.
  for (const body of el.querySelectorAll<HTMLElement>('.ib-body')) expect(body.textContent!.trim()).not.toBe('');
}, 30_000);

test.skipIf(!hasDom)('switch off: a Send of comments alone is drawn as before, its feedback in the message', async () => {
  await switchTo(false);
  const { sent: a0 } = await command<{ sent: string }>({ send: { project: world.project, session: 'ses_round_off', body: 'Deploys roll out to every store.' } });
  const feedback = await commentOn(a0, 'off-c1', 'every store', 'How do we roll back?');
  const { reply } = await postJson(`/api/inbox/messages/${a0}/reply`, { idempotency_key: 'off-r1', feedback, annotation_ids: ['off-c1'] });
  const el = await renderApp(`#thread=${a0}`);
  await until(() => articleOf(el, reply.id)?.querySelector('[data-reply-feedback]') != null, 'the feedback in the message');
  await settle();
  const message = articleOf(el, reply.id)!;
  expect(message.hasAttribute('data-round-line')).toBe(false);
  expect(message.querySelector('[data-round-fold]')).toBeNull();
  expect(message.querySelector('[data-reply-feedback]')!.textContent).toContain('How do we roll back?');
}, 30_000);
