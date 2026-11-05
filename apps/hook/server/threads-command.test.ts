import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewJournal, reviewJournalKey } from "@plannotator/shared/review-journal";
import { runReplyCommand, runThreadsCommand } from "./threads-command";

let root: string;
let dataDir: string;
const target = { kind: "last", host: "claude-code", session: "ses_a" } as const;
const key = () => reviewJournalKey(target);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "threads-command-"));
  dataDir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

async function run(command: typeof runThreadsCommand, argv: string[], stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await command(argv, { dataDir, cwd: root, out: (text) => out.push(text), err: (text) => err.push(text), stdin: stdin === undefined ? undefined : stream(stdin), stdinIsTTY: stdin === undefined });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const threads = (argv: string[], stdin?: string) => run(runThreadsCommand, argv, stdin);
const reply = (argv: string[], stdin?: string) => run(runReplyCommand, argv, stdin);
const call = async (action: string, args: Record<string, unknown>) => {
  const done = await threads([action, JSON.stringify({ target, ...args })]);
  expect(done.err).toBe("");
  return JSON.parse(done.out) as Record<string, any>;
};

describe("a client's side through the CLI", () => {
  test("comments, a Finish whose text tells the agent how to reply and read, the delivery, a resolution, the close", async () => {
    await call("comment", { id: "c1", on: { kind: "message", message_id: "m1" }, quote: "Lyon store", text: "Two stores." });
    await call("comment", { id: "c2", on: { kind: "message", message_id: "m1" }, text: "Shorter intro." });
    const sent = await call("send", { mode: "round" });
    expect(sent.review).toBe(key());
    expect(sent.send.comments).toEqual(["c1", "c2"]);
    expect(sent.text).toContain("(id c1)");
    expect(sent.text).toContain(`plannotator reply --review ${key()} <id> <<'END'`);
    expect((await call("delivered", { sends: [sent.send.id] })).sends[0].delivery).toBeTruthy();
    const view = await call("view", {});
    expect([view.review, view.view.v, view.view.round, view.view.threads.map((t: { status: string }) => t.status)]).toEqual([key(), 1, 2, ["delivered", "delivered"]]);
    expect((await call("resolve", { id: "c2" })).comment.resolved_at).toBeTruthy();
    expect((await call("close", {})).closed).toBe(true);
    expect(readReviewJournal(dataDir, { key: key() })).toBeNull();
  });

  test("a send's text again by its id, nothing written; a Finish with nothing to send writes no round", async () => {
    const empty = await threads(["send", JSON.stringify({ target, mode: "round" })]);
    expect([empty.code, empty.out, empty.err.split(":")[0]]).toEqual([1, "", "empty"]);
    expect(readReviewJournal(dataDir, { key: key() })).toBeNull();
    await call("comment", { id: "c1", on: { kind: "message", message_id: "m1" }, quote: "Lyon store", text: "Two stores." });
    await call("comment", { id: "c2", on: { kind: "message", message_id: "m1" }, quote: "Friday", text: "", type: "deletion" });
    const sent = await call("send", { mode: "round" });
    const again = await call("send", { id: sent.send.id });
    expect([again.replayed, again.send, again.text]).toEqual([true, sent.send, sent.text]);
    expect(readReviewJournal(dataDir, { key: key() })!.sends).toHaveLength(1);
    expect((await threads(["send", JSON.stringify({ target, id: "snd_nope" })])).err).toStartWith("not_found:");
    // Nothing new, and the open threads went to that session already: still a round naming them.
    expect((await call("send", { mode: "round" })).send.comments).toEqual(["c1", "c2"]);
    await call("resolve", { id: "c1" });
    await call("resolve", { id: "c2" });
    expect((await threads(["send", JSON.stringify({ target, mode: "round" })])).err).toStartWith("empty:");
    expect((await call("send", { mode: "round", words: "All good." })).send.words).toBe("All good.");
    const view = await call("view", {});
    expect(view.view.threads.map((t: { id: string; type: string }) => [t.id, t.type])).toEqual([["c1", "comment"], ["c2", "deletion"]]);
  });

  test("a refusal is a code and a message on stderr, nothing on stdout; bad JSON is a usage error", async () => {
    const missing = await threads(["resolve", JSON.stringify({ target, id: "c9" })]);
    expect([missing.code, missing.out, missing.err]).toEqual([1, "", "not_found: No sent comment or sub-thread c9."]);
    expect((await threads(["send", "{not json"])).code).toBe(2);
    expect((await threads(["view", JSON.stringify({ review: "../x" })])).code).toBe(1);
    const piped = await threads(["comment", "-"], JSON.stringify({ target: { kind: "file", path: "a.md" }, on: { kind: "file", path: join(root, "a.md") }, text: "From stdin." }));
    // A relative target is the caller's folder's file.
    expect([JSON.parse(piped.out).comment.text, JSON.parse(piped.out).review]).toEqual(["From stdin.", reviewJournalKey({ kind: "file", path: join(root, "a.md") })]);
  });
});

describe("the agent's side", () => {
  test("reply under an id, as words or on stdin; threads lists the review and shows its threads with the replies", async () => {
    await call("comment", { id: "c1", on: { kind: "message", message_id: "m1" }, quote: "Lyon store", text: "Two stores." });
    await call("send", { mode: "now", ids: ["c1"] });
    const help = await reply(["--review", key(), "c1", "Use", "-h", "for", "the", "flags."]);
    expect([help.code, readReviewJournal(dataDir, { key: key() })!.replies.at(-1)?.text]).toEqual([0, "Use -h for the flags."]);
    expect((await reply(["--review", key(), "-h"])).out).toStartWith("Usage:");
    const said = await reply(["--review", key(), "c1", "Added", "Nantes."]);
    expect([said.code, said.out]).toEqual([0, `Replied under c1 in review ${key()}.`]);
    expect((await reply(["--review", key(), "c1"], "Line one\nwith $HOME and `ticks`\n")).code).toBe(0);
    const state = readReviewJournal(dataDir, { key: key() })!;
    expect(state.replies.map((r) => [r.text, r.from.session])).toEqual([
      ["Use -h for the flags.", "ses_a"],
      ["Added Nantes.", "ses_a"],
      ["Line one\nwith $HOME and `ticks`", "ses_a"],
    ]);
    const list = await threads([]);
    expect(list.out).toBe(`${key()}  the last messages of claude-code session ses_a: round 1, 1 open, 0 drafts`);
    const shown = await threads(["--review", key()]);
    expect(shown.out.split("\n").slice(0, 3)).toEqual([`Review ${key()}, on the last messages of claude-code session ses_a`, "Round 1", '- c1 (open, round 1, replied) on your message m1: "Lyon store"']);
    expect(shown.out).toContain('- reply rep_');
    expect(shown.out).toContain('Claude Code: "Added Nantes."');
    await call("comment", { id: "d1", on: { kind: "message", message_id: "m1" }, text: "A draft of mine." });
    const json = JSON.parse((await threads(["--review", key(), "--json"])).out);
    expect([json.v, json.review, json.threads.map((t: { id: string }) => t.id), json.threads[0].replies.length]).toEqual([1, key(), ["c1"], 3]);
    expect((await threads(["--review", key()])).out).not.toContain("A draft of mine.");
  });

  test("a draft, an unknown id or no review: refused, nothing written", async () => {
    await call("comment", { id: "c1", on: { kind: "message", message_id: "m1" }, text: "Two stores." });
    const draft = await reply(["--review", key(), "c1", "x"]);
    expect([draft.code, draft.err]).toEqual([1, "not_found: c1 is not sent yet."]);
    expect((await reply(["c1", "x"])).code).toBe(2);
    expect((await reply(["--review", key(), "c1"])).code).toBe(2);
    expect((await reply(["--review", "last-000000000000000000000000", "c1", "x"])).err).toStartWith("not_found:");
    expect(readReviewJournal(dataDir, { key: key() })!.replies).toEqual([]);
  });
});
