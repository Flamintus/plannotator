/**
 * The person's comment sends on the wake, as the store keeps them
 * (experimental "persistent-comments"): what a session is handed and in
 * which order, what settles a send, and the Inbox's own Send now after the
 * wait. Proved on a real store in a temp dir with an injected clock; the
 * bridge's side is in packages/server/inbox-comment-send-delivery.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AUTO_SEND_AFTER_MS, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const START = Date.parse("2026-11-05T09:00:00.000Z");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-send-wake-"));
  roots.push(dir);
  const clock = { now: START };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Ship on Friday, all stores at once.", wakes: true }).message;
  const draft = (id: string) =>
    store.saveMessageAnnotation(asked.id, { id, blockId: "block-1", startOffset: 0, endOffset: 5, type: "COMMENT", text: `About ${id}.`, originalText: "Ship", createdA: 1 });
  const send = (ids: string[], key: string, mode: "now" | "round" = "now", with_message: string | null = null) =>
    store.writeCommentSends(asked.thread_id, { mode, round: 1, idempotency_key: key, sends: [{ to: { host: "claude-code", session: "ses_a" }, drafts: ids, named: [], with_message }] })[0]!;
  return { store, dir, clock, asked, draft, send };
}

test("a session is handed its replies and its sends in the order they came; together, a thread's sends are one item under the oldest", () => {
  const { store, clock, asked, draft, send } = setup();
  draft("c-1");
  draft("c-2");
  const one = send(["c-1"], "k-1");
  clock.now += 1000;
  const reply = store.sendReply(asked.id, { words: "And one more thing.", idempotency_key: "r-1" }).reply!;
  clock.now += 1000;
  const two = send(["c-2"], "k-2");
  expect(store.pendingWakeItems("ses_a", { sends: true }).map((item) => [item.id, item.sends.map((s) => s.id)])).toEqual([
    [one.id, [one.id]],
    [reply.id, []],
    [two.id, [two.id]],
  ]);
  expect(store.pendingWakeItems("ses_a", { together: true, sends: true }).map((item) => [item.id, item.sends.map((s) => s.id)])).toEqual([
    [one.id, [one.id, two.id]],
    [reply.id, []],
  ]);
  // Another session is handed none of them, and with sent comments off nothing but the reply.
  expect(store.pendingWakeItems("ses_b", { together: true, sends: true })).toEqual([]);
  expect(store.pendingWakeItems("ses_a", { together: true }).map((item) => [item.id, item.sends.length])).toEqual([[reply.id, 0]]);
});

test("together, a send that waited and rides a later message's words never brings them ahead of words written before them", () => {
  const { store, clock, asked, draft, send } = setup();
  draft("c-1");
  draft("c-2");
  // A comment sent now while the session is busy; then words alone; then the Finish with words.
  const now = send(["c-1"], "k-1");
  clock.now += 1000;
  const first = store.sendReply(asked.id, { words: "Looks good so far.", idempotency_key: "r-1" }).reply!;
  clock.now += 1000;
  const last = store.sendReply(asked.id, { words: "That is all for this round.", idempotency_key: "r-2" }).reply!;
  const finish = send(["c-2"], "k-2", "round", last.id);
  expect(store.pendingWakeItems("ses_a", { together: true, sends: true }).map((item) => [item.id, item.sends.map((s) => s.id)])).toEqual([
    [first.id, []],
    [last.id, [now.id, finish.id]],
  ]);
});

test("a send with words rides their message; the message's delivery settles it, a send for another session is never settled by it", () => {
  const { store, asked, draft, send } = setup();
  draft("c-1");
  const words = store.sendReply(asked.id, { words: "Two changes.", idempotency_key: "r-1" }).reply!;
  const riding = send(["c-1"], "k-1", "round", words.id);
  expect(store.pendingWakeItems("ses_a", { sends: true }).map((item) => [item.id, item.sends.map((s) => s.id)])).toEqual([[words.id, [riding.id]]]);
  store.recordDelivery(words.id, { host: "claude-code", session: "ses_a", commentSends: true });
  expect(store.commentSend(riding.id)!.delivery).toMatchObject({ session: "ses_a" });
  expect(store.pendingWakeItems("ses_a", { sends: true })).toEqual([]);
  expect(store.recordCommentSendsDelivery([riding.id], { host: "pi", session: "ses_b" })).toEqual([]);
});

test("after the wait, a send waiting alone on a busy session goes in by itself, once, as the Inbox's Send now", () => {
  const { store, clock, draft, send } = setup();
  draft("c-1");
  const one = send(["c-1"], "k-1");
  const clocks = new Map([[one.id, { since: clock.now, autoSince: clock.now }]]);
  const clockOf = (id: string) => clocks.get(id) ?? null;
  clock.now += INBOX_AUTO_SEND_AFTER_MS - 1;
  store.autoSendDue("ses_a", { afterMs: INBOX_AUTO_SEND_AFTER_MS, clockOf, commentSends: true });
  expect(store.commentSend(one.id)!.deliver_now_at ?? null).toBeNull();
  clock.now += 1;
  // Sent comments off: the send is left alone.
  store.autoSendDue("ses_a", { afterMs: INBOX_AUTO_SEND_AFTER_MS, clockOf });
  expect(store.commentSend(one.id)!.deliver_now_at ?? null).toBeNull();
  store.autoSendDue("ses_a", { afterMs: INBOX_AUTO_SEND_AFTER_MS, clockOf, commentSends: true });
  expect(store.commentSend(one.id)).toMatchObject({ deliver_now_by: "auto" });
  // A failed attempt clears the mark, and it never fires again by itself.
  store.clearCommentSendNow(one.id, "ses_a");
  store.autoSendDue("ses_a", { afterMs: INBOX_AUTO_SEND_AFTER_MS, clockOf, commentSends: true });
  expect(store.commentSend(one.id)!.deliver_now_at ?? null).toBeNull();
});

test("the sends survive a restart, still waiting until delivered", () => {
  const { dir, draft, send } = setup();
  draft("c-1");
  const one = send(["c-1"], "k-1");
  const again = InboxStore.open(dir);
  expect(again.pendingWakeItems("ses_a", { sends: true }).map((item) => item.id)).toEqual([one.id]);
  again.recordCommentSendsDelivery([one.id], { host: "claude-code", session: "ses_a" });
  expect(InboxStore.open(dir).pendingWakeItems("ses_a", { sends: true })).toEqual([]);
});
