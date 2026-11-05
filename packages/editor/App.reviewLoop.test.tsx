/**
 * The review loop on an annotate screen (DOM_TESTS=1; experimental
 * "persistent-comments" with a host that carries sends, as `GET /api/threads`
 * answers it). Send Feedback must end the round through `/api/threads/send`
 * with each comment by its id and leave the tab open, never posting today's
 * decision; a sent comment must stop counting as feedback (else the next
 * round, or Approve's notes, would send it again); the agent's reply must
 * come under its comment as a card; a reply to it must go under the right
 * thread; and Resolve must reach the server. With the loop unavailable the
 * page is today's: Send Feedback posts `/api/feedback`.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import type { Annotation } from "@plannotator/ui/types";

const hasDom = typeof document !== "undefined";

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
}

/** The stream the page listens on; a test pushes the server's events through it. */
class StreamEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static current: StreamEventSource | null = null;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = StreamEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    StreamEventSource.current = this;
    setTimeout(() => this.push({ type: "snapshot", annotations: [] }), 0);
  }

  push(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

const DOCUMENT = "# Release\n\nThe retry loop backs off too slowly.\n\nShip to all stores on Friday.\n";

const DRAFT: Annotation[] = [
  {
    id: "annRetry",
    blockId: "block-1",
    startOffset: 0,
    endOffset: 14,
    type: "COMMENT" as Annotation["type"],
    text: "make it exponential",
    originalText: "The retry loop",
    createdA: 1,
    startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
    endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 14 },
  },
];

interface Post { path: string; body: Record<string, unknown> }

let posts: Post[] = [];
let loopAvailable = true;
let view: { v: 1; round: number; threads: Record<string, unknown>[] } = { v: 1, round: 1, threads: [] };

const state = () => ({ available: true, review: "file-test", round: view.round, busy: false, view });

const sentThread = (comment: { id: string; quote?: string; text: string }, extra: Record<string, unknown> = {}) => ({
  id: comment.id,
  reply_id: "snd_01JCCCCCCCCCCCCCCCCCCCCCCC",
  round: 1,
  draft: false,
  state: "open",
  on: { kind: "file", path: "/tmp/release.md" },
  quote: comment.quote ?? "",
  text: comment.text,
  unanchored: false,
  folded: false,
  live: false,
  status: "delivered",
  replies: [],
  sub_threads: [],
  ...extra,
});

const agentReply = {
  id: "rep_01JDDDDDDDDDDDDDDDDDDDDDDD",
  author: { kind: "agent", host: "claude-code", session: "s1", name: null },
  author_name: "Claude Code",
  round: 1,
  message_id: "",
  text: "Doubled the backoff each try, up to 30 s.",
  at: "2026-11-05T10:00:00.000Z",
  draft: false,
  sub_threads: [],
};

function makeFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.pathname === "/api/plan") {
      return Response.json({ plan: DOCUMENT, origin: "claude-code", mode: "annotate", filePath: "/tmp/release.md", sharingEnabled: false, serverConfig: {} });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") {
      return method === "GET" ? Response.json({ annotations: DRAFT, globalAttachments: [], ts: 1 }) : Response.json({ ok: true });
    }
    if (url.pathname === "/api/threads") return Response.json(loopAvailable ? state() : { available: false });
    if (url.pathname === "/api/threads/send") {
      const sent = body();
      posts.push({ path: url.pathname, body: sent });
      const comments = (sent.comments as { id: string; quote?: string; text: string; re?: string }[]) ?? [];
      if (sent.mode === "round") {
        view = { v: 1, round: view.round + 1, threads: [...view.threads, ...comments.filter((c) => !c.re).map((c) => sentThread(c))] };
      } else {
        view = {
          ...view,
          threads: view.threads.map((thread) => {
            const replies = comments.filter((c) => c.re === thread.id).map((c) => ({ id: c.id, author: { kind: "person" }, author_name: null, round: view.round, message_id: "snd_01JEEEEEEEEEEEEEEEEEEEEEEE", text: c.text, at: "2026-11-05T10:05:00.000Z", draft: false, status: "pending", sub_threads: [] }));
            return replies.length > 0 ? { ...thread, live: true, replies: [...(thread.replies as unknown[]), ...replies] } : thread;
          }),
        };
      }
      return Response.json({ send: { id: "snd_01JFFFFFFFFFFFFFFFFFFFFFFF", round: sent.mode === "round" ? view.round - 1 : view.round, mode: sent.mode }, replayed: false, ...state() });
    }
    if (url.pathname === "/api/threads/resolve") {
      const resolved = body();
      posts.push({ path: url.pathname, body: resolved });
      view = { ...view, threads: view.threads.map((thread) => (thread.id === resolved.id ? { ...thread, state: resolved.resolved === false ? "open" : "resolved" } : thread)) };
      return Response.json({ comment: {}, ...state() });
    }
    if (url.pathname === "/api/feedback") {
      posts.push({ path: url.pathname, body: body() });
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  // SAFETY: the app only ever calls fetch(input, init).
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`);

async function mountAndRestore(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StreamEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20; attempt += 1) await settle();
  const restore = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Restore");
  if (!restore) throw new Error("Draft recovery dialog did not offer Restore");
  await act(async () => { restore.click(); });
  for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
  if (!card("annRetry")) throw new Error("the restored comment never reached the panel");
}

async function pressPrimary(): Promise<void> {
  const primary = document.querySelector<HTMLButtonElement>("[data-decision-primary]");
  if (!primary) throw new Error("decision control did not render");
  await act(async () => { primary.click(); });
  for (let attempt = 0; attempt < 10 && posts.length === 0; attempt += 1) await settle(10);
  await settle();
}

async function press(selector: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`no ${selector}`);
  await act(async () => { button.click(); });
  for (let attempt = 0; attempt < 5; attempt += 1) await settle(5);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  StreamEventSource.current = null;
  posts = [];
  loopAvailable = true;
  view = { v: 1, round: 1, threads: [] };
  memory.clear();
  sessionStorage.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("the review loop on an annotate screen", () => {
  test("Send Feedback ends the round in the same tab; the agent's reply, a reply to it and Resolve go through the loop", async () => {
    await mountAndRestore();

    await pressPrimary();
    expect(posts.map((post) => post.path)).toEqual(["/api/threads/send"]);
    expect(posts[0]!.body).toMatchObject({
      mode: "round",
      comments: [{ id: "annRetry", on: { kind: "file", path: "/tmp/release.md" }, quote: "The retry loop", text: "make it exponential" }],
    });
    // The tab stays: the comment is still in the panel, sent, and the header counts the round.
    expect(card("annRetry")?.querySelector('[data-review-loop-chip="status"]')?.textContent).toBe("Delivered");
    expect(document.querySelector("[data-review-loop-count]")?.textContent).toBe("Round 2 · 1 open");
    // Sent: no longer feedback, so the primary is no longer a Send of it, and the card takes no edit.
    expect(card("annRetry")?.querySelector('button[title="Edit"]')).toBeNull();

    // The agent answers under the comment's id: a card under it, New until the person looks.
    view = { ...view, threads: view.threads.map((thread) => ({ ...thread, status: "replied", replies: [agentReply] })) };
    await act(async () => { StreamEventSource.current?.push({ type: "review-threads", ...state() }); });
    await settle();
    const reply = card(agentReply.id);
    expect(reply?.textContent).toContain("Doubled the backoff");
    expect(reply?.closest("[data-annotation-reply]")?.getAttribute("data-annotation-depth")).toBe("1");
    expect(reply?.querySelector('[data-review-loop-chip="new"]')).not.toBeNull();
    await act(async () => { reply!.click(); });
    await settle();
    expect(card(agentReply.id)?.querySelector('[data-review-loop-chip="new"]')).toBeNull();

    // The person replies under the agent's reply: a draft, sent alone at once under the comment's thread.
    await act(async () => { card(agentReply.id)!.querySelector<HTMLButtonElement>('button[title="Reply"]')!.click(); });
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Cap it at 10 s instead.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
    const draft = Array.from(document.querySelectorAll<HTMLElement>("[data-annotation-id]")).find((element) => element.textContent?.includes("Cap it at 10 s instead."));
    const draftId = draft!.getAttribute("data-annotation-id")!;
    await press(`[data-review-loop-action="send"][data-review-loop-id="${draftId}"]`);
    expect(posts[1]?.body).toMatchObject({ mode: "now", comments: [{ id: draftId, re: "annRetry", text: "Cap it at 10 s instead." }] });

    await press('[data-review-loop-action="resolve"][data-review-loop-id="annRetry"]');
    expect(posts[2]).toEqual({ path: "/api/threads/resolve", body: { id: "annRetry", resolved: true } });
    expect(card("annRetry")?.querySelector('[data-review-loop-chip="resolved"]')).not.toBeNull();
    expect(posts.some((post) => post.path === "/api/feedback")).toBe(false);
  });

  test("with the loop unavailable, Send Feedback is today's decision", async () => {
    loopAvailable = false;
    await mountAndRestore();
    await pressPrimary();
    expect(posts.map((post) => post.path)).toEqual(["/api/feedback"]);
    expect(document.querySelector("[data-review-loop-count]")).toBeNull();
    expect(document.querySelector("[data-review-loop-action]")).toBeNull();
  });
});
