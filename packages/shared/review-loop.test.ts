import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewJournal, reviewJournalDir, reviewJournalKey, writeReviewComment, type ReviewTarget } from "./review-journal";
import { createReviewLoop, type ReviewLoopCarrier, type ReviewLoopOptions, type ReviewLoopRequest } from "./review-loop";

const TOKEN = "k".repeat(43);
const PORT = 4321;
let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-loop-"));
  dataDir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeCarrier(state: { ready?: boolean; busy?: boolean; toolReply?: boolean } = {}) {
  const delivered: { sendId: string; text: string; info: { mode: string; round: number; comments: number }; report: { delivered(): void; failed(message?: string): void } }[] = [];
  const carrier: ReviewLoopCarrier & { delivered: typeof delivered } = {
    get ready() {
      return state.ready ?? true;
    },
    get busy() {
      return state.busy ?? false;
    },
    get toolReply() {
      return state.toolReply ?? false;
    },
    deliver(sendId, text, info, report) {
      delivered.push({ sendId, text, info, report });
    },
    delivered,
  };
  return { carrier, state };
}

const target: ReviewTarget = { kind: "file", path: "/repo/notes.md" };
const onFile = { kind: "file" as const, path: "/repo/notes.md", lines: [3, 3] as [number, number] };

function loopOf(overrides: Partial<ReviewLoopOptions> = {}, carrier: ReviewLoopCarrier | null = fakeCarrier().carrier) {
  const events: { type: string; [key: string]: unknown }[] = [];
  const loop = createReviewLoop({
    dataDir,
    enabled: true,
    target,
    to: { host: "claude-code", session: "ses_1" },
    reviewId: "pn-3f2a9c",
    root: "/repo",
    carrier: () => carrier,
    broadcast: (event) => events.push(event as { type: string }),
    hostToken: () => TOKEN,
    getServerPort: () => PORT,
    pollMs: 60_000,
    log: () => {},
    ...overrides,
  });
  const page = (method: string, pathname: string, body?: unknown) =>
    loop.handle({ method, pathname, host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, authorization: null, body });
  const host = (method: string, pathname: string, body?: unknown, extra: Partial<ReviewLoopRequest> = {}) =>
    loop.handle({ method, pathname, host: `127.0.0.1:${PORT}`, origin: null, authorization: `Bearer ${TOKEN}`, body, ...extra });
  return { loop, events, page, host };
}

describe("review loop on a screen", () => {
  test("off without the setting, a target, a session or a host that carries sends: today's single decision", async () => {
    for (const [overrides, carrier] of [
      [{ enabled: false }, fakeCarrier().carrier],
      [{ target: null }, fakeCarrier().carrier],
      [{ to: null }, fakeCarrier().carrier],
      [{}, fakeCarrier({ ready: false }).carrier],
      [{}, null],
    ] as const) {
      const { loop, page } = loopOf(overrides, carrier);
      expect((await page("GET", "/api/threads"))!.body).toEqual({ available: false });
      expect((await page("POST", "/api/threads/send", { mode: "round", comments: [{ on: onFile, quote: "x", text: "y" }] }))!.status).toBe(409);
      loop.dispose();
    }
    expect(existsSync(join(dataDir, "reviews"))).toBe(false);
  });

  test("a round's send is written, composed with the tool's way to answer, handed to the host, and marked delivered", async () => {
    const { carrier } = fakeCarrier({ toolReply: true });
    const { loop, page, events } = loopOf({}, carrier);
    const answer = await page("POST", "/api/threads/send", {
      mode: "round",
      words: "Mostly fine.",
      comments: [
        { id: "c1", on: onFile, quote: "Ship on Friday.", text: "Not on a Friday.", notes: ["Attached image: /tmp/shot.png"] },
        { id: "c2", on: { kind: "file", path: "/repo/notes.md" }, quote: "", text: "Shorter overall." },
      ],
      idempotency_key: "press-1",
    });
    expect(answer!.status).toBe(200);
    const body = answer!.body as { available: boolean; round: number; send: { id: string; round: number; comments: string[] } };
    expect(body.available).toBe(true);
    expect(body.send.comments).toEqual(["c1", "c2"]);
    // The round ended: the next one is under way.
    expect(body.round).toBe(2);
    expect(carrier.delivered).toHaveLength(1);
    const [handed] = carrier.delivered;
    expect(handed!.info).toEqual({ mode: "round", round: 1, comments: 2 });
    expect(handed!.text.startsWith("Mostly fine.")).toBe(true);
    expect(handed!.text).toContain("(id c1)");
    expect(handed!.text).toContain("Attached image: /tmp/shot.png");
    expect(handed!.text).toContain('session "pn-3f2a9c"');
    expect(events.some((event) => event.type === "review-threads")).toBe(true);

    // A retry of the same press writes nothing and hands the undelivered send over again.
    const again = await page("POST", "/api/threads/send", { mode: "round", comments: [{ id: "c1", on: onFile, quote: "Ship on Friday.", text: "Not on a Friday." }], idempotency_key: "press-1" });
    expect((again!.body as { replayed: boolean }).replayed).toBe(true);
    expect(carrier.delivered).toHaveLength(2);

    handed!.report.delivered();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const journal = readReviewJournal(dataDir, { target })!;
    expect(journal.sends).toHaveLength(1);
    expect(journal.sends[0]!.delivery).toBeTruthy();
    loop.dispose();
  });

  test("without the tool, the text says how to answer with the CLI", async () => {
    const { carrier } = fakeCarrier();
    const { loop, page } = loopOf({}, carrier);
    await page("POST", "/api/threads/send", { mode: "now", comments: [{ id: "c1", on: onFile, quote: "q", text: "t" }] });
    expect(carrier.delivered[0]!.text).toContain(`plannotator reply --review ${reviewJournalKey(target)}`);
    expect(carrier.delivered[0]!.info.mode).toBe("now");
    loop.dispose();
  });

  test("the agent replies and reads through the host's paths; only with the host's token", async () => {
    const { loop, page, host } = loopOf();
    await page("POST", "/api/threads/send", { mode: "round", comments: [{ id: "c1", on: onFile, quote: "q", text: "Why?" }] });
    expect((await host("POST", "/api/host/threads/reply", { replies: [{ id: "c1", text: "Because." }] }, { authorization: "Bearer wrong" }))!.status).toBe(401);
    expect((await host("POST", "/api/host/threads/reply", { replies: [{ id: "c1", text: "Because." }] }, { origin: "http://evil" }))!.status).toBe(403);
    const replied = await host("POST", "/api/host/threads/reply", { replies: [{ id: "c1", text: "Because." }] });
    expect(replied!.status).toBe(200);
    expect((await host("POST", "/api/host/threads/reply", { replies: [{ id: "c9", text: "?" }] }))!.status).toBe(404);
    const read = await host("GET", "/api/host/threads");
    expect(read!.status).toBe(200);
    expect((read!.body as { text: string }).text).toContain("Because.");
    const journal = readReviewJournal(dataDir, { target })!;
    expect(journal.replies.map((reply) => reply.text)).toEqual(["Because."]);
    // Nothing of the agent's resolves.
    expect(journal.comments.every((comment) => !comment.resolved_at)).toBe(true);
    // The person resolves from the page.
    const resolved = await page("POST", "/api/threads/resolve", { id: "c1" });
    expect(resolved!.status).toBe(200);
    expect(readReviewJournal(dataDir, { target })!.comments[0]!.resolved_at).toBeTruthy();
    loop.dispose();
  });

  test("the host's paths are off for a review with no journal target", async () => {
    const { loop, host } = loopOf({ enabled: false });
    const answer = await host("GET", "/api/host/threads");
    expect(answer!.status).toBe(404);
    expect((answer!.body as { code: string }).code).toBe("review_loop_off");
    loop.dispose();
  });

  test("last: the agent's next messages join the picker's list, newest first, none it showed lost", async () => {
    const lastTarget: ReviewTarget = { kind: "last", host: "claude-code", session: "ses_1" };
    const shown = [{ messageId: "cc-b", text: "Second" }, { messageId: "cc-a", text: "First" }];
    const { loop, host, events } = loopOf({ target: lastTarget, messages: shown });
    expect(loop.messages()).toBeNull();
    const answer = await host("POST", "/api/host/messages", { v: 1, messages: [{ messageId: "cc-c", text: "Third" }, { messageId: "cc-b", text: "Second" }] });
    expect(answer!.status).toBe(200);
    expect(loop.messages()!.map((message) => message.messageId)).toEqual(["cc-c", "cc-b", "cc-a"]);
    expect(events.filter((event) => event.type === "messages")).toHaveLength(1);
    // The same list again changes nothing.
    await host("POST", "/api/host/messages", { v: 1, messages: [{ messageId: "cc-c", text: "Third" }] });
    expect(events.filter((event) => event.type === "messages")).toHaveLength(1);
    expect((await host("POST", "/api/host/messages", { v: 2, messages: [] }))!.status).toBe(400);
    loop.dispose();
  });

  // The failure this guards: a screen that kept today's single decision (no host carried sends) removed,
  // on Approve, threads another client had written for the same target.
  test("a screen that never carried the loop leaves the journal on approval", async () => {
    writeReviewComment({ dataDir }, { target }, { id: "c0", on: onFile, quote: "q", text: "from a terminal client" });
    const { loop } = loopOf({}, fakeCarrier({ ready: false }).carrier);
    await loop.approved();
    expect(existsSync(reviewJournalDir(dataDir, reviewJournalKey(target)))).toBe(true);
    loop.dispose();
  });

  test("a send the host could not put in the session is shown to the page until it is handed over again", async () => {
    const { carrier } = fakeCarrier();
    const { loop, page } = loopOf({}, carrier);
    const first = await page("POST", "/api/threads/send", { mode: "round", comments: [{ id: "c1", on: onFile, quote: "q", text: "t", notes: ["Attached image: /tmp/a.png"] }], idempotency_key: "press-1" });
    const sendId = (first!.body as { send: { id: string } }).send.id;
    carrier.delivered[0]!.report.failed("refused");
    expect(((await page("GET", "/api/threads"))!.body as { failed?: unknown }).failed).toEqual([{ send: sendId, message: "refused" }]);
    // The page's retry: the same press, handed over again with its notes.
    await page("POST", "/api/threads/send", { mode: "round", comments: [{ id: "c1", on: onFile, quote: "q", text: "t", notes: ["Attached image: /tmp/a.png"] }], idempotency_key: "press-1" });
    expect(carrier.delivered).toHaveLength(2);
    expect(carrier.delivered[1]!.text).toContain("Attached image: /tmp/a.png");
    expect(((await page("GET", "/api/threads"))!.body as { failed?: unknown }).failed).toBeUndefined();
    loop.dispose();
  });

  test("approving the review removes its journal", async () => {
    const { loop, page } = loopOf();
    await page("POST", "/api/threads/send", { mode: "round", comments: [{ id: "c1", on: onFile, quote: "q", text: "t" }] });
    expect(existsSync(reviewJournalDir(dataDir, reviewJournalKey(target)))).toBe(true);
    await loop.approved();
    expect(existsSync(reviewJournalDir(dataDir, reviewJournalKey(target)))).toBe(false);
    loop.dispose();
  });

  test("a write waits for another process's lock on timers, never blocking the server's event loop", async () => {
    writeReviewComment({ dataDir }, { target }, { id: "c0", on: onFile, quote: "q", text: "draft" });
    const lock = join(reviewJournalDir(dataDir, reviewJournalKey(target)), ".lock");
    writeFileSync(lock, "another process");
    const { loop, page } = loopOf();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    const sending = page("POST", "/api/threads/send", { mode: "round" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The loop kept turning while the send waited for the lock.
    expect(ticks).toBeGreaterThan(5);
    rmSync(lock);
    const answer = await sending;
    clearInterval(ticker);
    expect(answer!.status).toBe(200);
    expect((answer!.body as { send: { comments: string[] } }).send.comments).toEqual(["c0"]);
    loop.dispose();
  });

  test("the page is told when another process writes the journal", async () => {
    const { loop, events } = loopOf({ pollMs: 20 });
    writeReviewComment({ dataDir }, { target }, { id: "c0", on: onFile, quote: "q", text: "from a terminal client" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.some((event) => event.type === "review-threads" && event.available === true)).toBe(true);
    loop.dispose();
  });
});
