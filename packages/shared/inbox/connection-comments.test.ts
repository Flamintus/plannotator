/**
 * The wake of a command that delivers the person's comment sends
 * (`comments`): the instruction an agent reads, for comments alone, with the
 * person's words, and for a session the comments tag. The words are the
 * contract's constants; what is guarded is which line goes where.
 */
import { expect, test } from "bun:test";
import { INBOX_TAGGED_INSTRUCTION, INBOX_WAKE_INSTRUCTION, inboxCommentsWakeLine, inboxWakeText } from "./connection";

const base = { type: "reply" as const, thread_id: "msg_01THREAD", subject: "Rollout", body: "# Comments on your work\n\n### 1. Comment … (id c-1)\n> One store first." };

test("comments alone: the comments line is the instruction, and says the round and whether it is still open", () => {
  const now = inboxWakeText({ ...base, id: "snd_01A", comments: { sends: ["snd_01A"], round: 2, mode: "now", count: 1 } });
  expect(now.split("\n")[1]).toBe(inboxCommentsWakeLine({ round: 2, mode: "now", count: 1 }));
  expect(now).not.toContain(INBOX_WAKE_INSTRUCTION);
  expect(inboxCommentsWakeLine({ round: 2, mode: "now", count: 1 })).toContain("round 2 is still open");
  expect(inboxCommentsWakeLine({ round: 3, mode: "round", count: 2 })).toContain("finished round 3");
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
