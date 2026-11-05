/**
 * The review targets' pure rules (inbox-review-targets.ts): which thread a
 * drop goes in, what counts as already there, and when a chat message's
 * words are the agent's by its transcript. The route is proved through the
 * server in packages/server/inbox-review-targets.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { inboxReviewDuplicate, inboxReviewThreadOf, inboxReviewVerified, inboxReviewWords, type InboxImported } from "./inbox-review-targets";

const by = { kind: "cli" } as const;
function drop(id: string, imported: Omit<InboxImported, "by"> | null, extra: { session?: string; resolved?: boolean; kind?: "agent" | "person" } = {}) {
  return {
    id,
    author: { kind: extra.kind ?? "agent", session: extra.session ?? "ses-a" },
    resolved_at: extra.resolved ? "2026-11-05T10:00:00.000Z" : null,
    ...(imported ? { imported: { ...imported, by } } : {}),
  };
}
const chat = (sha256: string, host_message_id: string | null = null) => ({ from: "transcript" as const, sha256, host_message_id });
const file = (path: string) => ({ from: "file" as const, path });

describe("the thread a drop goes in", () => {
  test("is the session's newest open review thread of that target; another session's, another target's, or a resolved one is not", () => {
    const roots = [
      drop("msg_old", chat("a")),
      drop("msg_notes", file("/p/notes.md")),
      drop("msg_other", chat("a"), { session: "ses-b" }),
      drop("msg_agent", null),
      drop("msg_chat", chat("b")),
    ];
    expect(inboxReviewThreadOf(roots, "ses-a", "chat")?.id).toBe("msg_chat");
    expect(inboxReviewThreadOf(roots, "ses-a", "file:/p/notes.md")?.id).toBe("msg_notes");
    expect(inboxReviewThreadOf(roots, "ses-a", "file:/p/plan.md")).toBeNull();
    expect(inboxReviewThreadOf(roots, "ses-b", "chat")?.id).toBe("msg_other");
    // Resolved by the person: the next drop starts a new thread.
    expect(inboxReviewThreadOf([drop("msg_done", chat("a"), { resolved: true })], "ses-a", "chat")).toBeNull();
  });
});

describe("what is already there", () => {
  const thread = [drop("msg_1", chat("one", "m-1")), drop("msg_r", null, { kind: "person" }), drop("msg_2", chat("two")), drop("msg_3", chat("three", "m-3"))];

  test("a host id with the same words, anywhere in the thread", () => {
    expect(inboxReviewDuplicate(thread, { from: "transcript", host_message_id: "m-1", sha256: "one" })?.id).toBe("msg_1");
    // The same id with other words (the message changed): a new message.
    expect(inboxReviewDuplicate(thread, { from: "transcript", host_message_id: "m-1", sha256: "other" })).toBeNull();
  });

  test("without a host id, only the last one dropped, by its words", () => {
    expect(inboxReviewDuplicate(thread, { from: "transcript", host_message_id: null, sha256: "three" })?.id).toBe("msg_3");
    // The same words as an earlier drop are dropped again: the agent said them again.
    expect(inboxReviewDuplicate(thread, { from: "transcript", host_message_id: null, sha256: "two" })).toBeNull();
  });

  test("a file, by its path", () => {
    const files = [drop("msg_f", file("/p/notes.md"))];
    expect(inboxReviewDuplicate(files, { from: "file", path: "/p/notes.md" })?.id).toBe("msg_f");
    expect(inboxReviewDuplicate(files, { from: "file", path: "/p/plan.md" })).toBeNull();
  });
});

describe("the words are the agent's", () => {
  const transcript = [
    { id: "m-1", text: "First answer." },
    { id: "m-2", text: "I moved the retry loop.\n\n" },
    { id: "m-3", text: "The backoff is now 2, 4 and 8 seconds." },
  ];

  test("by the message the host id names, whatever the spacing; other words under that id are not", () => {
    expect(inboxReviewVerified("  First\nanswer. ", "m-1", transcript)).toBe(true);
    expect(inboxReviewVerified("Second answer.", "m-1", transcript)).toBe(false);
  });

  test("by one message, or a run of consecutive ones joined in any way, when no id is known", () => {
    expect(inboxReviewVerified("The backoff is now 2, 4 and 8 seconds.", null, transcript)).toBe(true);
    expect(inboxReviewVerified("I moved the retry loop.\nThe backoff is now 2, 4 and 8 seconds.", "cc-0123", transcript)).toBe(true);
    expect(inboxReviewVerified("First answer. The backoff is now 2, 4 and 8 seconds.", null, transcript)).toBe(false);
  });

  test("not when the transcript cannot be read", () => {
    expect(inboxReviewVerified("First answer.", "m-1", null)).toBe(false);
  });

  test("the fingerprint's words are blind to spacing only", () => {
    expect(inboxReviewWords("a\n\n b\tc ")).toBe(inboxReviewWords("a b c"));
    expect(inboxReviewWords("a b")).not.toBe(inboxReviewWords("a  B"));
  });
});
