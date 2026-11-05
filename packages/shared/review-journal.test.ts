import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchorReviewComment,
  closeReviewJournal,
  isReviewJournalKey,
  listReviewJournals,
  markReviewSendsDelivered,
  readReviewJournal,
  removeReviewComment,
  replyInReview,
  resolveReviewComment,
  reviewJournalAgentRead,
  reviewJournalDir,
  reviewJournalKey,
  reviewJournalPendingSends,
  reviewJournalSendText,
  reviewJournalStamp,
  reviewJournalView,
  reviewJournalWakeText,
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
    // The passage's offset counts whitespace runs as one, as the screens mark it (passage.ts).
    replyInReview(opts(), ref, [{ id: "c1", text: "Intro.\n\n    foo bar foo" }]);
    const spaced = readReviewJournal(dataDir, ref)!.replies[1]!;
    expect(writeReviewComment(opts(), ref, { parent: spaced.id, quote: "foo", text: "which?" }).quote_offset).toBe("Intro. ".length);
  });

  test("the drafts are the person's: the view shows them, what an agent reads does not", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] });
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "draft" });
    const state = readReviewJournal(dataDir, ref);
    expect(reviewJournalView(state).threads.map((thread) => [thread.id, thread.draft])).toEqual([["c1", false], ["c2", true]]);
    expect(reviewJournalView(state, { sent: true }).threads.map((thread) => thread.id)).toEqual(["c1"]);
  });

  test("an anchor follows the words, or keeps that they are gone from one round to the next", () => {
    writeReviewComment(opts(), ref, { id: "f1", on: { kind: "file", path: "/a.md", lines: [3, 3] }, text: "one" });
    sendReviewComments(opts(), ref, { mode: "now", ids: ["f1"] });
    expect(anchorReviewComment(opts(), ref, "f1", { on: { kind: "file", path: "/a.md", lines: [5, 5] }, unanchored: false }).on).toEqual({ kind: "file", path: "/a.md", lines: [5, 5] });
    const gone = anchorReviewComment(opts(), ref, "f1", { unanchored: true }).unanchored_at;
    expect(anchorReviewComment(opts(), ref, "f1", { unanchored: true }).unanchored_at).toBe(gone);
    expect(reviewJournalView(readReviewJournal(dataDir, ref)).threads[0]!.unanchored).toBe(true);
    expect(anchorReviewComment(opts(), ref, "f1", { unanchored: false }).unanchored_at).toBeNull();
    expect(refused(() => anchorReviewComment(opts(), ref, "f1", { on: onMessage, unanchored: false }))).toBe("invalid");
  });

  test("sends written in the same millisecond, or after the clock went back, keep their rounds", () => {
    const frozen = { dataDir, now: () => Date.UTC(2026, 10, 5, 10) };
    for (let i = 0; i < 6; i++) {
      writeReviewComment(frozen, ref, { id: `c${i}`, on: onMessage, text: `note ${i}` });
      sendReviewComments(frozen, ref, { mode: "round" });
    }
    const state = readReviewJournal(dataDir, ref)!;
    expect(state.sends.map((send) => send.round)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(reviewJournalView(state).round).toBe(7);
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

  test("a round is not a message: its wake is one line, and the agent's read carries what it has not answered before every thread", () => {
    const how = { read: "READ.", reply: "REPLY.", wake: "WAKE." };
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one", notes: ["Attached image: /tmp/c1.png", " "] });
    expect(refused(() => writeReviewComment(opts(), ref, { id: "c9", on: onMessage, text: "x", notes: "no" as unknown as string[] }))).toBe("invalid");
    const first = sendReviewComments(opts(), ref, { mode: "now", ids: ["c1"] });
    let state = readReviewJournal(dataDir, ref)!;
    expect(state.comments[0]!.notes).toEqual(["Attached image: /tmp/c1.png"]);
    expect(reviewJournalWakeText(state, [first.send.id], how)).toStartWith("WAKE. Answer now");
    expect(reviewJournalWakeText(state, [first.send.id], how)).not.toContain("one");
    // The comment's notes, as its client wrote them, under its heading.
    const read = reviewJournalAgentRead(state, { root, how });
    expect(read.indexOf("(id c1)\nAttached image: /tmp/c1.png\n> one")).toBeGreaterThan(-1);
    expect(read).toContain("REPLY.");
    expect(read.indexOf("(id c1)")).toBeLessThan(read.indexOf("- c1 (open"));
    // Answered: the read is the threads alone, as before; the next round waits again.
    replyInReview(opts(), ref, [{ id: "c1", text: "done" }]);
    state = readReviewJournal(dataDir, ref)!;
    expect(reviewJournalPendingSends(state)).toEqual([]);
    expect(reviewJournalAgentRead(state, { root, how })).toStartWith("Round 1\n- c1 (open");
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "two" });
    const finish = sendReviewComments(opts(), ref, { mode: "round" });
    state = readReviewJournal(dataDir, ref)!;
    expect(reviewJournalPendingSends(state).map((send) => send.id)).toEqual([finish.send.id]);
    expect(reviewJournalAgentRead(state, { root, how })).not.toContain("(id c1)");
    expect(reviewJournalAgentRead(null, { root, how })).toBe("Round 1: no comment yet.");
    // A send that came while the agent answered the one before stays waiting: its own comment has no reply yet.
    writeReviewComment(opts(), ref, { id: "c3", on: onMessage, text: "three" });
    const late = sendReviewComments(opts(), ref, { mode: "now", ids: ["c3"] });
    replyInReview(opts(), ref, [{ id: "c2", text: "done too" }]);
    state = readReviewJournal(dataDir, ref)!;
    expect(reviewJournalPendingSends(state).map((send) => send.id)).toEqual([late.send.id]);
    // A round with nothing to read, words included, says so.
    expect(reviewJournalWakeText({ ...state, sends: [{ ...finish.send, comments: [], words: null }] }, [finish.send.id], how)).toStartWith("No comment is open");
    expect(reviewJournalWakeText({ ...state, sends: [{ ...finish.send, comments: [], words: "Edits." }] }, [finish.send.id], how)).toStartWith("WAKE.");
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
  test("a reply goes under a sent comment, a reply's id answering its comment, from the session the send that carried the id went to", () => {
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
    expect(replyInReview(opts(), ref, [{ id: "c1", text: "And Lyon." }]).replies[0]!.from.session).toBe("ses_a");
  });

  test("a reply shows its send reached the session: replied, in that send's round, even with no delivery marked", () => {
    writeReviewComment(opts(), ref, { id: "c1", on: onMessage, text: "one" });
    sendReviewComments(opts(), ref, { mode: "round" });
    writeReviewComment(opts(), ref, { id: "c2", on: onMessage, text: "two" });
    sendReviewComments(opts(), ref, { mode: "now", ids: ["c2"] });
    replyInReview(opts(), ref, [{ id: "c2", text: "Done." }]);
    const state = readReviewJournal(dataDir, ref)!;
    expect(state.sends.map((send) => [send.round, !!send.read_at])).toEqual([[1, false], [2, true]]);
    const view = reviewJournalView(state);
    expect(view.threads.map((thread) => [thread.id, thread.status, thread.replies.map((reply) => reply.round)])).toEqual([
      ["c1", "pending", []],
      ["c2", "replied", [2]],
    ]);
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
