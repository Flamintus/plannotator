/**
 * Comment sends of the Plannotator Inbox (experimental "persistent-comments"):
 * the person's comments, their replies under a comment and their sub-threads
 * (inbox-comment-threads.ts) reach an agent session as a record of their own,
 * never as a message of the thread, so the thread keeps only the
 * conversation. One record per agent session a press reaches, linked by
 * `batch`; the store keeps them in their own file (`comment-sends.jsonl`),
 * which an older Inbox skips.
 *
 * - `now` sends one draft at once and leaves the round open; `round` (the
 *   person's Finish) sends every draft left and ends the round, naming the
 *   threads still open by id. The round is the count of Finishes before it,
 *   plus one, continuing the rounds the person's replies carried before
 *   (`inboxCommentRoundNow`).
 * - A thread a `now` send reached is live, as crit's live threads: the
 *   person's next replies in it go on their own (`inboxLiveCommentThreads`).
 * - Each element a send carries has a status the send gives it: pending,
 *   delivered, read, working, replied (`inboxCommentSendStatus`).
 * - The text an agent reads is composed here from the records
 *   (`inboxCommentSendText`), so the window, a phone and a terminal client
 *   send the same words.
 * - The thread view (`inboxCommentThreadView`): the comment threads as a
 *   tree, versioned, built from the thread model with nothing of its own
 *   (drafts, statuses, folds and live threads included), for any client to
 *   draw.
 *
 * Browser-safe and zero-dep.
 */

import type { InboxAnnotationRecord, InboxCommentReplyRecord } from "./inbox-attachments";
import {
  INBOX_OPEN_COMMENTS_SENT,
  inboxCommentEntry,
  inboxCommentLastReplies,
  inboxCommentMessages,
  inboxCommentRoundNow,
  inboxCommentSendReceivedAt,
  inboxCommentsInOrder,
  inboxCommentThreads,
  inboxOpenSubThreadPaths,
  isInboxCommentAskedAgain,
  isInboxCommentReply,
  isInboxCommentThreadFolded,
  type InboxCommentReply,
  type InboxCommentRoundSend,
  type InboxCommentEntryDetail,
  type InboxCommentThread,
  type InboxCommentThreadMessage,
} from "./inbox-comment-threads";
import { diagramAnchorLocationLine, parseDiagramAnchor } from "./diagram-anchor";
import type { InboxDeliverNowBy } from "./inbox-delivery";
import { inboxAgentName, type InboxDelivery, type InboxMessage, type InboxTag } from "./inbox-types";
import { ulid } from "./ulid";

/** `now`: one draft at once, the round stays open; `round`: the person's Finish, every draft left, and the round ends. */
export type InboxCommentSendMode = InboxCommentRoundSend["mode"];

/** One comment send: what one press sends one agent session. Its own record kind, `comment_send`. */
export interface InboxCommentSend {
  /** `snd_<ULID>` (inboxCommentSendId). */
  id: string;
  project_id: string;
  thread_id: string;
  /** Shared by the sends of one press, one per session it reaches. */
  batch: string;
  /** The agent session it goes to: the one whose message or file the comments are on. */
  to: { host: string | null; session: string };
  /** The sessions its comments tag with `@`, each handed it too, with a delivery of its own. */
  tags?: InboxTag[];
  /** The round it was sent in: `inboxCommentRoundNow` when it was written. */
  round: number;
  mode: InboxCommentSendMode;
  /**
   * The comments it carries, by id: the drafts it sent (each record's
   * `sent_reply_id` is then this send's id) and, on a Finish, the threads
   * still open that went to this session before, named only.
   */
  comments: string[];
  /** The person's message carrying the words sent with it (a mixed send); its text follows them. Null otherwise. */
  with_message: string | null;
  /** The sender's idempotency key, when one was given: a retry of the same press writes nothing new. */
  idempotency_key: string | null;
  created_at: string;
  /** The person asked for it to go into the running turn (as a reply's `deliver_now_at`). */
  deliver_now_at?: string | null;
  /** Who asked for `deliver_now_at`: the person, or the Inbox after the wait (as a reply's `deliver_now_by`). */
  deliver_now_by?: InboxDeliverNowBy | null;
  /** It reached its session, through the session's connection. */
  delivery?: InboxDelivery | null;
  /** Its session read it (read_thread), with or without a delivery. */
  read_at?: string | null;
}

const SEND_ID_RE = /^snd_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A new comment send's id. */
export function inboxCommentSendId(now?: number): string {
  return `snd_${ulid(now)}`;
}

export function isInboxCommentSendId(value: unknown): value is string {
  return typeof value === "string" && SEND_ID_RE.test(value);
}

/** Whether a stored line's record reads as a comment send (a reader skips one that does not). */
export function isInboxCommentSendRecord(value: unknown): value is InboxCommentSend {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const to = record.to as Record<string, unknown> | null | undefined;
  const nullableText = (field: unknown) => field === null || typeof field === "string";
  const optional = (field: unknown, check: (value: unknown) => boolean) => field === undefined || field === null || check(field);
  return (
    isInboxCommentSendId(record.id) &&
    [record.project_id, record.thread_id, record.batch, record.created_at].every((field) => typeof field === "string") &&
    !!to &&
    typeof to === "object" &&
    typeof to.session === "string" &&
    nullableText(to.host) &&
    Number.isInteger(record.round) &&
    (record.round as number) >= 1 &&
    (record.mode === "now" || record.mode === "round") &&
    Array.isArray(record.comments) &&
    record.comments.every((id) => typeof id === "string") &&
    nullableText(record.with_message) &&
    nullableText(record.idempotency_key) &&
    optional(record.tags, Array.isArray) &&
    optional(record.deliver_now_at, (field) => typeof field === "string") &&
    optional(record.delivery, (field) => typeof field === "object" && typeof (field as Record<string, unknown>).at === "string") &&
    optional(record.read_at, (field) => typeof field === "string")
  );
}

/** Whether a comment record is a draft a send can carry: not sent, not removed, and not on a guided review (its comments go with the person's verdict). */
export function isInboxCommentSendable(record: Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at" | "guide">): boolean {
  return record.sent_reply_id === null && record.removed_at === null && !record.guide;
}

/**
 * The threads a Finish to `session` names as still open: those sent to that
 * session before (`sentTo` names the session a thread's carrier went to, a
 * comment send's `to` or the person's reply's recipient), still open, never a
 * guided review's comment. Their words are not sent again: the agent has them.
 */
export function inboxOpenCommentsToName(threads: readonly InboxCommentThread[], session: string, sentTo: (carrier: string) => string | null): InboxCommentThread[] {
  return threads.filter((thread) => isInboxCommentAskedAgain(thread) && sentTo(thread.reply_id) === session);
}

/**
 * The live threads, by id: each a `now` send carried, or carried a reply of
 * the person's under. As crit's live threads, a thread stays live once it is:
 * the person's next replies in it go on their own (`inboxCommentDraftIsLive`).
 * A sub-thread is a thread of its own: it is live once a `now` send carried it.
 */
export function inboxLiveCommentThreads(
  sends: readonly Pick<InboxCommentSend, "id" | "mode" | "comments">[],
  records: readonly Pick<InboxAnnotationRecord, "id" | "re" | "sent_reply_id">[],
): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const live = new Set<string>();
  for (const send of sends) {
    if (send.mode !== "now") continue;
    for (const id of send.comments) {
      const record = byId.get(id);
      if (record?.sent_reply_id !== send.id) continue;
      live.add(isInboxCommentReply(record) ? record.re! : record.id);
    }
  }
  return live;
}

/** Whether a draft goes on its own, as a `now` send: a reply of the person's under a live thread. */
export function inboxCommentDraftIsLive(draft: Pick<InboxAnnotationRecord, "re" | "sent_reply_id" | "removed_at">, live: ReadonlySet<string>): boolean {
  return draft.sent_reply_id === null && draft.removed_at === null && isInboxCommentReply(draft) && live.has(draft.re!);
}

/** The agent session a comment send goes to. */
export type InboxCommentSendAddress = InboxCommentSend["to"];

/** What routing a press needs of a message of the thread. */
export interface InboxCommentSendMessage {
  id: string;
  author: { kind: string; host?: string | null; session?: string | null };
  /** The person's message addressed to a session (a New message, a reply sent to another session, a hand-off). */
  to?: { host: string | null; session: string } | null;
  handoff?: { undone_at?: string | null } | null;
}

/**
 * The agent session a message of the thread is for: an agent's, the session
 * that wrote it; the person's, the session it is addressed to (`to`). Null
 * when it names none.
 */
export function inboxCommentSendAddress(message: InboxCommentSendMessage): InboxCommentSendAddress | null {
  if (message.author.kind === "agent") return message.author.session ? { host: message.author.host ?? null, session: message.author.session } : null;
  return message.to ? { host: message.to.host ?? null, session: message.to.session } : null;
}

/**
 * The message the person's words answer: the latest agent message, except in
 * a thread handed to another session (approval "inbox-tag-handoff"): then the
 * new owner's latest message after the hand-off, else the hand-off reply
 * itself (a reply to it is addressed as it is, to the new owner). So the
 * former owner writing again never takes the person's words back. With no
 * agent message, the thread's first. The window's Send and a comment send
 * read it alike.
 */
export function inboxWordsMessage<M extends InboxCommentSendMessage>(messages: readonly M[]): M | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const handoff = messages[index]!;
    if (handoff.author.kind !== "person" || !handoff.handoff || handoff.handoff.undone_at || !handoff.to) continue;
    const owner = handoff.to.session;
    return messages.slice(index + 1).filter((m) => m.author.kind === "agent" && m.author.session === owner).at(-1) ?? handoff;
  }
  return messages.filter((m) => m.author.kind === "agent").at(-1) ?? messages[0];
}

/**
 * Where the drafts of one press go, one group per agent session, as the
 * window's Send routes the comments it carries (packages/inbox/sendTargets.ts
 * `routeSendAnnotations`): a comment on an agent's message, and a reply or
 * sub-thread under one (they keep its place), goes to the session that wrote
 * that message; any other, on a file or a guided review, to the session the
 * person's words go to (`words`), whose group comes last. A draft with
 * nowhere to go is in a group whose `to` is null.
 */
export function inboxCommentSendRoutes<R extends Pick<InboxAnnotationRecord, "message" | "message_id">>(
  drafts: readonly R[],
  messageOf: (id: string) => InboxCommentSendMessage | undefined,
  words: InboxCommentSendAddress | null,
): { to: InboxCommentSendAddress | null; drafts: R[] }[] {
  const keyOf = (to: InboxCommentSendAddress | null) => (to ? `${to.host ?? ""}\0${to.session}` : "");
  const groups = new Map<string, { to: InboxCommentSendAddress | null; drafts: R[] }>();
  for (const draft of drafts) {
    const message = draft.message ? messageOf(draft.message_id) : undefined;
    const to = (message?.author.kind === "agent" ? inboxCommentSendAddress(message) : null) ?? words;
    const key = keyOf(to);
    const group = groups.get(key) ?? groups.set(key, { to, drafts: [] }).get(key)!;
    group.drafts.push(draft);
  }
  const last = groups.get(keyOf(words));
  return last ? [...[...groups.values()].filter((group) => group !== last), last] : [...groups.values()];
}

/** What became of an element a send carried, as the person sees it: never words for the agent. */
export type InboxCommentSendStatus = "pending" | "delivered" | "read" | "working" | "replied";

/**
 * The status a send gives an element it carried, for its session: `replied`
 * once an agent replied under its thread after the send reached that session
 * (`lastAgentReplyAt`, the newest agent's reply there; a reply before it
 * answered something else); else `working` while that session, which the
 * send reached, is busy (`busy`: the caller knows the session's state); else
 * `read` (read_thread showed it), `delivered`, or `pending`.
 */
export function inboxCommentSendStatus(send: Pick<InboxCommentSend, "to" | "delivery" | "read_at">, lastAgentReplyAt: string | null, busy: boolean): InboxCommentSendStatus {
  const received = inboxCommentSendReceivedAt(send);
  if (received === null) return "pending";
  if (lastAgentReplyAt !== null && lastAgentReplyAt > received) return "replied";
  if (busy) return "working";
  return typeof send.read_at === "string" ? "read" : "delivered";
}

/** The title of the text a comment send gives the agent. */
export const INBOX_COMMENT_SEND_TITLE = "Comments on your work";

/**
 * What one session reads of its sends, oldest first (one, or the ones not yet
 * delivered that one delivery takes together), composed from the records:
 * after the words of a mixed send (`words`), a section with what the round
 * is, one entry per comment, reply and sub-thread the sends carried (its id,
 * where it is, the words it is on, its text; a sub-thread with the words its
 * passage is in, from `agentReplies` and the sent records), and, after a
 * Finish, the threads still open named by id and counted, their words not
 * repeated. A `now` send says the round is still open.
 */
export function inboxCommentSendText(input: {
  sends: readonly InboxCommentSend[];
  /** The thread's comment records. */
  records: readonly InboxAnnotationRecord[];
  agentReplies?: readonly InboxCommentReplyRecord[];
  /** The project's root: a file's place is shown from it. */
  root: string;
  words?: string;
  /** What the caller knows of each entry beyond its record (`inboxCommentEntry`'s `detail`): its lines in the file, its notes. */
  detail?: (record: InboxAnnotationRecord) => InboxCommentEntryDetail;
}): string {
  const words = input.words?.trim() ?? "";
  const sends = [...input.sends].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (sends.length === 0) return words;
  const ids = new Set(sends.map((send) => send.id));
  const carried = inboxCommentsInOrder(input.records.filter((record) => record.sent_reply_id !== null && ids.has(record.sent_reply_id) && record.removed_at === null));
  const carriedIds = new Set(carried.map((record) => record.id));
  const named = [...new Set(sends.filter((send) => send.mode === "round").flatMap((send) => send.comments))].filter((id) => !carriedIds.has(id));
  const messages = inboxCommentMessages(input.records, input.agentReplies ?? []);
  const entries = carried.map((record, index) => inboxCommentEntry(record, index + 1, input.root, messages, input.detail?.(record)));
  const last = sends.at(-1)!;
  const finished = sends.filter((send) => send.mode === "round").reduce<number | null>((round, send) => (round === null || send.round > round ? send.round : round), null);
  const done = finished !== null ? `The person finished round ${finished}.` : "";
  const intro =
    last.mode === "now"
      ? `${done ? `${done} ` : ""}Round ${last.round} is still open: the person may send more. Answer under each id now; do not wait for the round to end.`
      : entries.length === 0 && named.length === 0
        ? `${done} No comment is open.`
        : `${done} Answer under each id.`;
  const shown = named.slice(-INBOX_OPEN_COMMENTS_SENT);
  const older = named.length - shown.length;
  const open = named.length > 0 ? [`Still open, already sent to you (${named.length}): ${shown.join(", ")}${older > 0 ? ` and ${older} older` : ""}. read_thread has their words and replies.`] : [];
  const section = [`# ${INBOX_COMMENT_SEND_TITLE}`, intro, ...entries, ...open].join("\n\n");
  return words ? `${words}\n\n${section}` : section;
}

/** The thread view's shape: a client checks it before it reads the rest. */
export const INBOX_COMMENT_THREAD_VIEW_VERSION = 1;

/** One reply under a thread in the view, with the sub-threads on its words. */
export interface InboxCommentReplyNode extends Omit<InboxCommentReply, "draft"> {
  /** The agent's name as people read it ("Claude Code"); null for the person's, whom a client names itself ("You"). */
  author_name: string | null;
  /** The person's reply not sent yet: its round is the one under way. */
  draft: boolean;
  /** The person's reply a comment send carried: what became of it. */
  status?: InboxCommentSendStatus;
  sub_threads: InboxCommentThreadNode[];
  /**
   * Replies to this reply, for a source whose replies nest (the document
   * editor's `inReplyTo` chains). The Inbox never fills it: its replies are
   * one flat list under their thread, as crit's, and depth comes from
   * sub-threads, each on a passage.
   */
  replies?: InboxCommentReplyNode[];
}

/** One thread in the view: a comment, or a sub-thread under the message whose passage it is on. */
export interface InboxCommentThreadNode extends Omit<InboxCommentThread, "replies" | "parent" | "draft"> {
  /** A sub-thread: the message it is on (its parent node in the tree, or a message no longer found), and where the passage starts in its words. */
  parent?: { id: string; quote_offset: number };
  /** The person's draft, not sent yet (`reply_id` is ''; its round is the one under way). */
  draft: boolean;
  /** Drawn folded: resolved, with nothing open under it at any depth (`isInboxCommentThreadFolded`). */
  folded: boolean;
  /** A thread a comment send carried: what became of it. */
  status?: InboxCommentSendStatus;
  /** A `now` send reached it: the person's next replies in it go on their own. */
  live: boolean;
  replies: InboxCommentReplyNode[];
  /** The sub-threads on its own words. */
  sub_threads: InboxCommentThreadNode[];
}

/** The comment threads of an Inbox thread, as any client draws them. */
export interface InboxCommentThreadView {
  v: typeof INBOX_COMMENT_THREAD_VIEW_VERSION;
  /** The round under way (`inboxCommentRoundNow`). */
  round: number;
  /** The threads on the thread's messages and files, oldest round first (the drafts after what was sent in the round under way), each sub-thread under the message it is on. */
  threads: InboxCommentThreadNode[];
}

/**
 * The comment threads as a tree, from the thread model
 * (`inboxCommentThreads`, drafts included: rounds, state, place, replies,
 * unanchored) plus what the sends give: each element's status (`busy` names
 * the sessions in a turn now) and whether a thread is live; and whether each
 * thread is folded. It shows what it is given: the person's drafts among
 * `records` are listed (`draft`) and open a resolved comment again, as in
 * the window; without them it is what was sent. A sub-thread sits under the
 * message it is on, at any depth; one whose message is gone, or that a
 * broken writer left in a loop, sits at the top.
 */
export function inboxCommentThreadView(input: {
  messages: readonly InboxCommentThreadMessage[];
  records: readonly InboxAnnotationRecord[];
  agentReplies?: readonly InboxCommentReplyRecord[];
  sends?: readonly InboxCommentSend[];
  busy?: (session: string) => boolean;
}): InboxCommentThreadView {
  const agentReplies = input.agentReplies ?? [];
  const sends = input.sends ?? [];
  const threads = inboxCommentThreads(input.messages, input.records, agentReplies, sends, { drafts: true });
  const sendsById = new Map(sends.map((send) => [send.id, send]));
  const live = inboxLiveCommentThreads(sends, input.records);
  const answered = inboxCommentLastReplies([], agentReplies);
  const statusOf = (carrier: string, thread: string): { status?: InboxCommentSendStatus } => {
    const send = sendsById.get(carrier);
    return send ? { status: inboxCommentSendStatus(send, answered.get(thread) ?? null, input.busy?.(send.to.session) ?? false) } : {};
  };
  // What folds: the window's rule, over what is listed (a draft sub-thread is open, and keeps what it is under unfolded).
  const shown = new Set(threads.flatMap((thread) => [thread.id, ...thread.replies.map((reply) => reply.id)]));
  const resolved = new Set(threads.filter((thread) => thread.state === "resolved").map((thread) => thread.id));
  const openBelow = inboxOpenSubThreadPaths(
    input.records.filter((record) => shown.has(record.id)),
    agentReplies,
    (id) => !resolved.has(id),
  );
  const nodes = new Map<string, InboxCommentThreadNode>();
  const replyNodes = new Map<string, InboxCommentReplyNode>();
  /** The thread each message of a thread belongs to: a thread to itself, a reply to the thread it is under. */
  const owner = new Map<string, string>();
  for (const { replies, parent, draft, ...thread } of threads) {
    const node: InboxCommentThreadNode = {
      ...thread,
      ...(parent ? { parent: { id: parent.id, quote_offset: parent.quote_offset } } : {}),
      draft: draft === true,
      folded: isInboxCommentThreadFolded(thread.id, resolved, openBelow),
      ...statusOf(thread.reply_id, thread.id),
      live: live.has(thread.id),
      replies: replies.map(({ draft: unsent, ...reply }) => {
        const replyNode: InboxCommentReplyNode = {
          ...reply,
          author_name: reply.author.kind === "agent" ? inboxAgentName(reply.author) : null,
          draft: unsent === true,
          ...(reply.author.kind === "person" ? statusOf(reply.message_id, thread.id) : {}),
          sub_threads: [],
        };
        replyNodes.set(reply.id, replyNode);
        owner.set(reply.id, thread.id);
        return replyNode;
      }),
      sub_threads: [],
    };
    nodes.set(thread.id, node);
    owner.set(thread.id, thread.id);
  }
  /** Whether a sub-thread's way up reaches a thread at the top, never itself. */
  const reachesTop = (node: InboxCommentThreadNode): boolean => {
    const seen = new Set([node.id]);
    for (let at = node.parent ? owner.get(node.parent.id) : undefined; at !== undefined; ) {
      if (seen.has(at)) return false;
      seen.add(at);
      const up = nodes.get(at)!.parent;
      at = up ? owner.get(up.id) : undefined;
    }
    return true;
  };
  const top: InboxCommentThreadNode[] = [];
  for (const node of nodes.values()) {
    const host = node.parent ? (replyNodes.get(node.parent.id) ?? nodes.get(node.parent.id)) : undefined;
    if (host && reachesTop(node)) host.sub_threads.push(node);
    else top.push(node);
  }
  return { v: INBOX_COMMENT_THREAD_VIEW_VERSION, round: inboxCommentRoundNow(input.messages, input.records, sends), threads: top };
}

// ──────────── Delivery (the wake): what a session's connection hands over ────────────

/**
 * One item a session's wake hands over, oldest first: the person's message
 * (`message`) with the comment sends that ride it (its words' sends, and,
 * when the connection takes them together, the thread's other sends waiting
 * for that session), or comment sends alone (`message` null). `id` is the
 * message's, or the oldest send's: the wake's command carries it, and
 * `reply_to` takes it.
 */
export interface InboxWakeItem {
  id: string;
  thread_id: string;
  message: InboxMessage | null;
  sends: InboxCommentSend[];
}

/** What a send records for one session: its own fields for its recipient, a tag's for a session it tags. */
export type InboxCommentSendMark = Pick<InboxCommentSend, "delivery" | "read_at" | "deliver_now_at" | "deliver_now_by">;

/** A send's mark for `session` (its own, or the tag's), or null when the send does not go to that session. */
export function inboxCommentSendMark(send: InboxCommentSend, session: string): InboxCommentSendMark | null {
  if (send.to.session === session) return send;
  return send.tags?.find((tag) => tag.session === session) ?? null;
}

/** The send with `patch` on its mark for `session` (its own fields, or that tag's). */
export function inboxCommentSendMarked(send: InboxCommentSend, session: string, patch: Partial<InboxCommentSendMark>): InboxCommentSend {
  if (send.to.session === session) return { ...send, ...patch };
  return { ...send, tags: (send.tags ?? []).map((tag) => (tag.session === session ? { ...tag, ...patch } : tag)) };
}

/**
 * What `session`'s wake hands over, oldest first by `seqOf`: each of the
 * person's messages waiting for it, with the sends its words carry
 * (`with_message`), and each send waiting alone. `together` (a connection
 * that posts `sends` back with `delivered`): a thread's sends go as one
 * item, riding its first item with sends of its own, never mixing what goes
 * to the session as the recipient with what only tags it.
 */
export function inboxWakeItems(
  session: string,
  messages: readonly InboxMessage[],
  sends: readonly InboxCommentSend[],
  options: { together: boolean; seqOf: (id: string) => number },
): InboxWakeItem[] {
  const { seqOf } = options;
  const items: InboxWakeItem[] = messages.map((message) => ({ id: message.id, thread_id: message.thread_id, message, sends: [] }));
  const byMessage = new Map(items.map((item) => [item.id, item]));
  const own = (send: InboxCommentSend) => send.to.session === session;
  const alone: InboxCommentSend[] = [];
  for (const send of [...sends].sort((a, b) => seqOf(a.id) - seqOf(b.id))) {
    const words = send.with_message ? byMessage.get(send.with_message) : undefined;
    if (words) words.sends.push(send);
    else alone.push(send);
  }
  for (const send of alone) {
    const joined = options.together ? items.find((item) => item.thread_id === send.thread_id && item.sends.length > 0 && own(item.sends[0]!) === own(send)) : undefined;
    if (joined) joined.sends.push(send);
    else items.push({ id: send.id, thread_id: send.thread_id, message: null, sends: [send] });
  }
  const first = (item: InboxWakeItem) => Math.min(item.message ? seqOf(item.message.id) : Infinity, ...item.sends.map((send) => seqOf(send.id)));
  for (const item of items) item.sends.sort((a, b) => seqOf(a.id) - seqOf(b.id));
  return items.sort((a, b) => first(a) - first(b));
}

/** The `comments` field of a wake's command: the sends it delivers (frozen when the command is made), their round and mode, how many comments they carry. */
export interface InboxCommentsWake {
  sends: string[];
  round: number;
  mode: InboxCommentSendMode;
  count: number;
}

/**
 * The `comments` field for the sends one command delivers, oldest first (the
 * order given, the store's): their ids, the newest send's round and mode,
 * and the comments, replies and sub-threads they carry (`records`, the
 * thread's comment records; the threads a Finish only names are not
 * counted).
 */
export function inboxCommentsWake(sends: readonly InboxCommentSend[], records: readonly Pick<InboxAnnotationRecord, "sent_reply_id" | "removed_at">[]): InboxCommentsWake {
  const ids = new Set(sends.map((send) => send.id));
  const last = sends.at(-1)!;
  return {
    sends: sends.map((send) => send.id),
    round: last.round,
    mode: last.mode,
    count: records.filter((record) => record.removed_at === null && record.sent_reply_id !== null && ids.has(record.sent_reply_id)).length,
  };
}

/**
 * The lines of `text` a document comment's words are on (from 1), or null
 * when they are not there as written: the words whole, else their first and
 * last lines, in that order. The words are the rendered text the person
 * selected, so a formatted span may not be found; the entry then names no
 * lines.
 */
export function inboxQuoteLines(text: string, quote: string): [number, number] | null {
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  const words = quote.replace(/\r\n?/g, "\n").trim();
  if (!words) return null;
  const whole = text.indexOf(words);
  if (whole >= 0) return [lineAt(whole), lineAt(whole + words.length)];
  const lines = words.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const first = text.indexOf(lines[0]!);
  const last = first < 0 ? -1 : text.indexOf(lines.at(-1)!, first + lines[0]!.length);
  return first >= 0 && last >= 0 ? [lineAt(first), lineAt(last)] : null;
}

const ENTRY_NOTE_MAX = 300;

function noteLine(value: string): string {
  const line = value.replace(/\s+/g, " ").replace(/`+/g, "'").trim();
  return line.length > ENTRY_NOTE_MAX ? `${line.slice(0, ENTRY_NOTE_MAX - 1)}…` : line;
}

/** A pinpointed HTML element, as one line: its path (or tag) and accessible name, else its selector. */
function elementNote(context: unknown, anchor: unknown): string | null {
  const c = context && typeof context === "object" ? (context as Record<string, unknown>) : null;
  const where = typeof c?.path === "string" && c.path ? c.path : typeof c?.tag === "string" ? c.tag : null;
  const selector = anchor && typeof anchor === "object" && typeof (anchor as Record<string, unknown>).selector === "string" ? ((anchor as Record<string, unknown>).selector as string) : null;
  const name = typeof c?.name === "string" && c.name ? ` "${c.name}"` : "";
  if (where) return noteLine(`Element: ${where}${name}`);
  return selector ? noteLine(`Element: ${selector}`) : null;
}

/**
 * The lines a comment send's entry adds under its heading, from the record
 * alone: the part of a diagram it is on, the HTML element it pinpoints, the
 * images attached to it (their paths), and the agents it tags with `@`
 * (`tagNames` names their sessions; none without it). The window's export of
 * a comment says the same.
 */
export function inboxCommentEntryNotes(record: Pick<InboxAnnotationRecord, "annotation">, tagNames: (sessions: readonly string[]) => string[] = () => []): string[] {
  const annotation = record.annotation as Record<string, unknown>;
  const notes: string[] = [];
  const diagram = annotation.diagramAnchor === undefined ? null : parseDiagramAnchor(annotation.diagramAnchor);
  if (diagram) notes.push(noteLine(diagramAnchorLocationLine(diagram)));
  const element = elementNote(annotation.elementContext, annotation.htmlAnchor);
  if (element) notes.push(element);
  const images = Array.isArray(annotation.images)
    ? annotation.images.flatMap((image) => (image && typeof image === "object" && typeof (image as { path?: unknown }).path === "string" && (image as { path: string }).path ? [(image as { path: string }).path] : []))
    : [];
  if (images.length > 0) notes.push(`Images attached: ${images.join(", ")}`);
  const mentions = Array.isArray(annotation.mentions) ? annotation.mentions.filter((id): id is string => typeof id === "string" && id !== "") : [];
  const names = mentions.length > 0 ? tagNames(mentions) : [];
  if (names.length > 0) notes.push(`Tagged ${names.join(", ")}: ${names.length === 1 ? "it gets" : "they get"} this comment too.`);
  return notes;
}
