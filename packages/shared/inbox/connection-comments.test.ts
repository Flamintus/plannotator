/**
 * The wake of a command that delivers the person's comment sends
 * (`comments`): the instruction an agent reads, for comments alone, with the
 * person's words, and for a session the comments tag. The words are the
 * contract's constants; what is guarded is which line goes where.
 */
import { expect, test } from "bun:test";
import { INBOX_TAGGED_INSTRUCTION, INBOX_WAKE_INSTRUCTION, inboxCommentsOnlyWakeLine, inboxCommentsWakeLine, inboxWakeText } from "./connection";

const base = { type: "reply" as const, thread_id: "msg_01THREAD", subject: "Rollout", body: "# Comments on your work\n\n### 1. Comment … (id c-1)\n> One store first." };

test("comments alone: a round is not a message, so one line says the round, reads the comments by the send's id, and the body stays out", () => {
  const comments = { sends: ["snd_01A"], round: 2, mode: "now" as const, count: 1 };
  const now = inboxWakeText({ ...base, id: "snd_01A", comments });
  const lines = now.split("\n");
  expect(lines[1]).toBe(inboxCommentsOnlyWakeLine(comments, "snd_01A"));
  expect(lines[1]).toContain("read_thread (message_id snd_01A)");
  expect(now).not.toContain(base.body);
  expect(lines.slice(2).filter(Boolean)).toHaveLength(1);
  expect(now).not.toContain(INBOX_WAKE_INSTRUCTION);
  expect(inboxCommentsOnlyWakeLine(comments, "snd_01A")).toContain("round 2 is still open");
  expect(inboxCommentsOnlyWakeLine({ round: 3, mode: "round", count: 2 }, "snd_01A")).toContain("finished round 3");
  // The tool as the host registered it; an unusable name falls back to the plain one.
  expect(inboxWakeText({ ...base, id: "snd_01A", comments }, "mcp__plannotator__plannotator_inbox")).toContain("mcp__plannotator__plannotator_inbox read_thread (message_id snd_01A)");
  expect(inboxCommentsOnlyWakeLine(comments, "snd_01A", "no such tool")).toBe(inboxCommentsOnlyWakeLine(comments, "snd_01A"));
});

test("with the person's words: their reply's instruction stays, the comments line follows it", () => {
  const wake = inboxWakeText({ ...base, id: "msg_01WORDS", comments: { sends: ["snd_01A"], round: 1, mode: "round", count: 1 } });
  const lines = wake.split("\n");
  expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
  expect(lines[2]).toBe(inboxCommentsWakeLine({ round: 1, mode: "round", count: 1 }));
});

test("a tagged session keeps the tagged wake, with the comments line; a malformed field is ignored", () => {
  const tagged = inboxWakeText({ ...base, id: "snd_01A", tagged: { owner: "Pi" }, comments: { sends: ["snd_01A"], round: 1, mode: "now", count: 1 } });
  expect(tagged).toContain(INBOX_TAGGED_INSTRUCTION);
  expect(tagged).toContain(inboxCommentsWakeLine({ round: 1, mode: "now", count: 1 }));
  const plain = inboxWakeText({ ...base, id: "msg_01R" });
  expect(inboxWakeText({ ...base, id: "msg_01R", comments: { sends: "snd_01A", mode: "later" } })).toBe(plain);
});
