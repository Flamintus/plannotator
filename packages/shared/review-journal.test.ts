import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeReviewJournal,
  isReviewJournalKey,
  listReviewJournals,
  markReviewSendsDelivered,
  readReviewJournal,
  removeReviewComment,
  replyInReview,
  resolveReviewComment,
  reviewJournalDir,
  reviewJournalKey,
  reviewJournalSendText,
  reviewJournalStamp,
  reviewJournalView,
  ReviewJournalError,
  sendReviewComments,
  writeReviewComment,
  type ReviewTarget,
} from "./review-journal";

let root: string;
let dataDir: string;
let clock: number;
const opts = () => ({ dataDir, now: () => clock++ * 1000 + Date.UTC(2026, 10, 5, 10) });
const last: ReviewTarget = { kind: "last", host: "claude-code", session: "ses_a" };
const ref = { target: last };
const onMessage = { kind: "message" as const, message_id: "m1" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-journal-"));
  dataDir = join(root, "data");
  clock = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function refused(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReviewJournalError) return error.code;
    throw error;
  }
  throw new Error("not refused");
}

describe("keys", () => {
  test("one key per target, a file by its real path; a key never names a path outside the journals", () => {
    const file = join(root, "plan.md");
    writeFileSync(file, "# plan\n");
    symlinkSync(file, join(root, "link.md"));
    expect(reviewJournalKey({ kind: "file", path: join(root, "link.md") })).toBe(reviewJournalKey({ kind: "file", path: file }));
    expect(reviewJournalKey(last)).toBe(reviewJournalKey({ ...last }));
    expect(reviewJournalKey(last)).not.toBe(reviewJournalKey({ ...last, session: "ses_b" }));
    expect(reviewJournalKey({ kind: "plan", project: "p", slug: "s" })).toMatch(/^plan-[0-9a-f]{24}$/);
    expect(isReviewJournalKey("../../etc")).toBe(false);
    expect(refused(() => reviewJournalDir(dataDir, "last-../x"))).toBe("invalid");
  });
});

describe("the person's side", () => {
  test("a draft is edited by its id until sent; a reply is on its comment's words, a sub-thread on its passage", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, quote: "Lyon store", text: "first" });
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, quote: "Lyon store", text: "two stores" });
    expect(readReviewJournal(dataDir, ref)!.comments.map((c) => [c.id, c.text])).toEqual([["c1", "two stores"]]);
    expect(refused(() => writeReviewComment(opts(), ref, { re: "c1", text: "a reply under a draft" }))).toBe("not_found");
    sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] });
    expect(refused(() => writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "again" }))).toBe("conflict");
    const reply = writeReviewComment(opts(), ref, { re: "c1", text: "and Nantes" });
    expect([reply.on, reply.quote, reply.re]).toEqual([onMessage, "Lyon store", "c1"]);
    replyInReview(opts(), { key: reviewJournalKey(last) }, [{ id: "c1", text: "Done: Lyon and Nantes." }]);
    const agent = readReviewJournal(dataDir, ref)!.replies[0]!;
    const sub = writeReviewComment(opts(), ref, { parent: agent.id, quote: "Nantes", text: "why Nantes?" });
    expect([sub.on, sub.parent, sub.quote_offset]).toEqual([onMessage, agent.id, "Done: Lyon and ".length]);
    expect(refused(() => writeReviewComment(opts(), ref, { text: "nowhere" }))).toBe("invalid");
  });

  test("a now send leaves the round open; a Finish carries every draft left and names the open threads sent to that session", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "two" });
    const now = sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] });
    expect([now.send.round, now.send.mode, now.send.comments, now.send.to]).toEqual([1, "now", ["c1"], { host: "claude-code", session: "ses_a" }]);
    writeReviewComment(opts(), ref, { id: "c3", on: onMessage, text: "three" });
    const finish = sendReviewComments(opts(), ref, { mode: "round", words: "Overall fine." });
    expect([finish.send.round, finish.send.comments, finish.send.words]).toEqual([1, ["c2", "c3", "c1"], "Overall fine."]);
    const state = readReviewJournal(dataDir, ref)!;
    expect(state.comments.every((c) => c.sent_reply_id !== null)).toBe(true);
    expect(reviewJournalView(state).round).toBe(2);
    const text = reviewJournalSendText(state, [finish.send.id], { root, how: { read: "READ.", reply: "REPLY." } });
    expect(text.startsWith("Overall fine.\n\n# Comments on your work\n\nThe person finished round 1.")).toBe(true);
    expect(text).toContain("Still open, already sent to you (1): c1. READ.");
    expect(text.endsWith("REPLY.")).toBe(true);
    expect(refused(() => sendReviewComments(opts(), { target: { kind: "file", path: join(root, "a.md") } }, { mode: "round" }))).toBe("invalid");
  });

  test("a retried send writes nothing new; a send's own line lost leaves its drafts waiting", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    const first = sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"], idempotency_key: "k1" });
    const again = sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"], idempotency_key: "k1" });
    expect([again.replayed, again.send.id]).toEqual([true, first.send.id]);
    const path = join(reviewJournalDir(dataDir, reviewJournalKey(last)), "journal.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    // Torn mid-write: the send's line half there, as a crash leaves it.
    writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n${lines.at(-1)!.slice(0, 40)}`);
    const state = readReviewJournal(dataDir, ref)!;
    expect([state.sends.length, state.comments[0]!.sent_reply_id]).toEqual([0, null]);
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "two" });
    expect(readReviewJournal(dataDir, ref)!.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("only a sent comment or sub-thread is resolved; removing a comment takes what is under it", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    expect(refused(() => resolveReviewComment(opts(), ref, "c1", true))).toBe("not_found");
    sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] });
    writeReviewComment(opts(), ref, { id: "r1", re: "c1", text: "reply" });
    sendReviewComments(opts(), ref, { mode: "now", ids: ["r1"] });
    expect(refused(() => resolveReviewComment(opts(), ref, "r1", true))).toBe("not_found");
    expect(resolveReviewComment(opts(), ref, "c1", true).resolved_at).not.toBeNull();
    expect(reviewJournalView(readReviewJournal(dataDir, ref)).threads[0]!.state).toBe("resolved");
    replyInReview(opts(), ref, [{ id: "c1", text: "one more thing" }]);
    expect(reviewJournalView(readReviewJournal(dataDir, ref)).threads[0]!.state).toBe("open");
    writeReviewComment(opts(), ref, { id: "s1", parent: "r1", quote: "reply", text: "sub" });
    expect(removeReviewComment(opts(), ref, "c1").sort()).toEqual(["c1", "r1", "s1"]);
    expect(reviewJournalView(readReviewJournal(dataDir, ref)).threads).toEqual([]);
  });
});

describe("the agent's side", () => {
  test("a reply goes under a sent comment, a reply's id answering its comment, from the session the newest send went to", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "two" });
    sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] });
    writeReviewComment(opts(), ref, { id: "r1", re: "c1", text: "and?" });
    sendReviewComments(opts(), ref, { mode: "now", ids: ["r1"], to: { host: "pi", session: "ses_p" } });
    expect(refused(() => replyInReview(opts(), ref, [{ id: "c2", text: "x" }]))).toBe("not_found");
    expect(refused(() => replyInReview(opts(), ref, [{ id: "nope", text: "x" }]))).toBe("not_found");
    expect(refused(() => replyInReview(opts(), ref, [{ id: "c1", text: "  " }]))).toBe("invalid");
    // All or none: one bad reply writes nothing.
    expect(refused(() => replyInReview(opts(), ref, [{ id: "c1", text: "ok" }, { id: "c2", text: "x" }]))).toBe("not_found");
    const done = replyInReview(opts(), ref, [{ id: "r1", text: "Both." }], { idempotency_key: "k" });
    expect(done.replies.map((reply) => [reply.re, reply.from.host, reply.from.session])).toEqual([["c1", "pi", "ses_p"]]);
    expect(replyInReview(opts(), ref, [{ id: "r1", text: "Both." }], { idempotency_key: "k" }).replayed).toBe(true);
    expect(readReviewJournal(dataDir, ref)!.replies).toHaveLength(1);
  });
});

describe("the journal on disk", () => {
  test("a review is listed while it has a journal; closing it removes its folder, and a write by key then finds none", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    const key = reviewJournalKey(last);
    const before = reviewJournalStamp(dataDir, { key });
    markReviewSendsDelivered(opts(), ref, [sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] }).send.id]);
    expect(reviewJournalStamp(dataDir, { key })).not.toBe(before);
    expect(readReviewJournal(dataDir, ref)!.sends[0]!.delivery).toBeTruthy();
    expect(listReviewJournals(dataDir).map((review) => [review.key, review.target, review.open])).toEqual([[key, last, 1]]);
    expect(closeReviewJournal(opts(), { key })).toBe(true);
    expect(existsSync(reviewJournalDir(dataDir, key))).toBe(false);
    expect(refused(() => writeReviewComment(opts(), { key }, { id: "c2", on: onMessage, text: "two" }))).toBe("not_found");
    expect(listReviewJournals(dataDir)).toEqual([]);
  });

  test("a refused first write leaves no folder; a lock left by a dead process is broken", () => {
    const key = reviewJournalKey(last);
    expect(refused(() => writeReviewComment(opts(), ref, { text: "nowhere" }))).toBe("invalid");
    expect(existsSync(reviewJournalDir(dataDir, key))).toBe(false);
    const dir = reviewJournalDir(dataDir, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".lock"), "dead");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock"), old, old);
    expect(writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" }).id).toBe("c1");
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  test("writers in three processes take turns: each Finish counts its own round and carries its own draft", async () => {
    const script = join(root, "writer.ts");
    const module = join(import.meta.dir, "review-journal.ts");
    writeFileSync(
      script,
      `import { sendReviewComments, writeReviewComment } from ${JSON.stringify(module)};
const [dataDir, who] = process.argv.slice(2);
const ref = { target: { kind: "last", host: "claude-code", session: "ses_a" } };
for (let i = 0; i < 15; i++) {
  writeReviewComment({ dataDir }, ref, { id: who + "-" + i, on: { kind: "message", message_id: "m1" }, text: "note " + i });
  sendReviewComments({ dataDir }, ref, { mode: "round" });
}
`,
    );
    const writers = ["a", "b", "c"].map((who) => Bun.spawn([process.execPath, script, dataDir, who], { stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0, 0]);
    const state = readReviewJournal(dataDir, ref)!;
    expect(state.comments).toHaveLength(45);
    expect(state.sends.map((send) => send.round).sort((a, b) => a - b)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    const carried = state.sends.flatMap((send) => state.comments.filter((c) => c.sent_reply_id === send.id && send.comments.includes(c.id)).map((c) => c.id));
    expect(carried.sort()).toEqual(state.comments.map((c) => c.id).sort());
  });

  test("a torn last line gets a newline before the next write, so both stay readable", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    const path = join(reviewJournalDir(dataDir, reviewJournalKey(last)), "journal.jsonl");
    appendFileSync(path, '{"v":1,"kind":"comm');
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "two" });
    expect(readReviewJournal(dataDir, ref)!.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
