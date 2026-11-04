/**
 * The person answers the agent under its comment (DOM_TESTS=1): Reply on the
 * agent's card in the annotations panel, then Send. The reply must thread
 * under that card in the panel and reach the agent nested under the
 * comment it answers, with the person's name, in both the feedback text and
 * the annotations array. A reply that loses its parent on the way would
 * read to the agent as a new, unrelated comment. In between it behaves like
 * any comment the person makes: highlighted as a reload would paint it, and
 * one undo step (undo takes card and highlight away, redo brings both back).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

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

/** The agent's comment, delivered as the external-annotation stream's opening snapshot. */
const AGENT_COMMENT = {
  id: "ext-1",
  blockId: "",
  startOffset: 0,
  endOffset: 0,
  type: "COMMENT",
  text: "Ship on Friday?",
  originalText: "Ship to all stores.",
  createdA: 1,
  author: "claude",
  source: "claude",
};

class SnapshotEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = SnapshotEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    setTimeout(() => {
      this.onmessage?.({ data: JSON.stringify({ type: "snapshot", annotations: [AGENT_COMMENT] }) } as MessageEvent);
    }, 0);
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

interface SubmittedBody {
  feedback?: string;
  annotations?: Array<{ id: string; text?: string; author?: string; inReplyTo?: string }>;
}

let submissions: SubmittedBody[] = [];

function makeFetch(): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: "# Release\n\nShip to all stores.\n",
        origin: "claude-code",
        mode: "annotate",
        filePath: "/tmp/release.md",
        sharingEnabled: false,
        serverConfig: {},
      });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/feedback") {
      submissions.push(JSON.parse(String(init?.body ?? "{}")) as SubmittedBody);
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const agentCard = () => document.querySelector<HTMLElement>('[data-annotation-id="ext-1"]');

async function mount(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SnapshotEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 30 && !agentCard(); attempt += 1) await settle();
  if (!agentCard()) throw new Error("the agent's comment never reached the panel");
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  submissions = [];
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("Reply in the annotations panel", () => {
  test("a reply to the agent's comment threads under it and is sent nested under that comment", async () => {
    await mount();

    await act(async () => { agentCard()!.querySelector<HTMLButtonElement>('button[title="Reply"]')!.click(); });
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Not on a Friday. Tuesday works.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();

    const replyCard = document.querySelector<HTMLElement>('[data-annotation-reply="true"] [data-annotation-id]');
    expect(replyCard?.textContent).toContain("Not on a Friday. Tuesday works.");
    expect(replyCard?.closest("[data-annotation-reply]")?.getAttribute("data-annotation-depth")).toBe("1");
    const replyId = replyCard!.getAttribute("data-annotation-id")!;
    const card = () => document.querySelector(`[data-annotation-id="${replyId}"]`);
    const mark = () => document.querySelector(`[data-bind-id="${replyId}"], [data-highlight-id="${replyId}"]`);
    expect(mark()).not.toBeNull();

    const key = async (init: KeyboardEventInit) => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      });
      await settle();
    };
    await key({ key: "z", metaKey: true });
    expect(card()).toBeNull();
    expect(mark()).toBeNull();
    await key({ key: "z", metaKey: true, shiftKey: true });
    expect(card()).not.toBeNull();
    expect(mark()).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();

    expect(submissions).toHaveLength(1);
    const reply = submissions[0]!.annotations?.find((a) => a.inReplyTo === "ext-1");
    expect(reply?.text).toBe("Not on a Friday. Tuesday works.");
    expect(reply?.author).toBeTruthy();
    const feedback = submissions[0]!.feedback ?? "";
    const entry = feedback.slice(feedback.indexOf("> Ship on Friday?"));
    expect(entry).toStartWith(`> Ship on Friday?\n**Replies:**\n- **Reply (${reply!.author}):** Not on a Friday. Tuesday works.\n`);
  });
});
