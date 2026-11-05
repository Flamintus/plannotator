/**
 * Comment sends on the Inbox server (experimental "persistent-comments"):
 * the person's comments reach an agent session as records of their own
 * (packages/core/inbox-comment-sends.ts), never as a message of the thread.
 *
 *   POST /api/inbox/threads/:id/comment-sends
 *     { serverSession?, mode: "now" | "round", comment_ids?, words?, idempotency_key }
 *     → { sends: InboxCommentSend[], message: InboxMessage | null, replayed }
 *
 * - `now`: the drafts named go at once (the window names one: a comment, a
 *   reply under a comment or a sub-thread) and the round stays open.
 * - `round`: the person's Finish: every draft left, and a send to every
 *   session the round's sends reached and to the one the words go to, drafts
 *   or none, each naming the threads still open that went to it before
 *   (their words are not sent again). `comment_ids` is not read.
 * - `words`: the person's words too, written as their reply to the message
 *   the words answer (`inboxWordsMessage`), and the send to that session
 *   names it (`with_message`); with no send to that session (a `now` whose
 *   drafts go elsewhere) they go as a plain reply.
 *
 * One send per agent session, linked by `batch`, routed as the window routes
 * a Send's comments (`inboxCommentSendRoutes`); the `@` tags of the comments
 * a send carries ride it, checked as a reply's are. The round is counted
 * once per press. A press is idempotent on its key: a retry answers the sends
 * it wrote. Every refusal comes before anything is written. The shape is
 * the one the device door is to take as it is.
 *
 * Live threads, as crit's: once a `now` send reached a thread, the person's
 * reply under it goes on its own, whichever client saved it
 * (`liveCommentReply`, from the reply route), so every client has one rule;
 * the same save sent again (a lost answer) answers what it sent
 * (`liveCommentReplyAgain`).
 *
 * Off, the route answers 409 `persistent_comments_off` and writes nothing.
 */

import {
  inboxCommentDraftIsLive,
  inboxCommentSendAddress,
  inboxCommentSendRoutes,
  inboxLiveCommentThreads,
  inboxOpenCommentsToName,
  inboxWordsMessage,
  isInboxCommentSendable,
  type InboxCommentSend,
  type InboxCommentSendMode,
} from "@plannotator/core/inbox-comment-sends";
import { inboxCommentRoundNow, inboxCommentRounds, inboxCommentThreads } from "@plannotator/core/inbox-comment-threads";
import type { InboxAnnotationRecord, InboxMessage, InboxTag } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export interface InboxCommentSendsContext {
  store: InboxStore;
  /** The sessions the person's `@` tags name, as a reply's tags (inbox-sessions.ts `tagTargets`): refuses one that cannot be tagged. Absent: no tags ride. */
  tagTargets?: (value: { session: string }[]) => InboxTag[];
}

export interface InboxCommentSendResult {
  sends: InboxCommentSend[];
  /** The person's message carrying the press's words, or null. */
  message: InboxMessage | null;
  /** A retry of a press already written: nothing new. */
  replayed: boolean;
}

/** The sessions a comment tags with `@` (its annotation's `mentions`), as the window reads them. */
function mentionsOf(record: InboxAnnotationRecord): string[] {
  const mentions = record.annotation.mentions;
  return Array.isArray(mentions) ? mentions.filter((id): id is string => typeof id === "string" && id !== "") : [];
}

/** One press of the person's (see the header): checked, planned, then written; a retry under the same key answers what it wrote. */
export function sendComments(context: InboxCommentSendsContext, threadId: string, body: Record<string, unknown>): InboxCommentSendResult {
  const { store } = context;
  const mode = body.mode;
  if (mode !== "now" && mode !== "round") throw new InboxError("validation_error", 'mode: "now" (the drafts named, the round stays open) or "round" (Finish).', { field: "mode" });
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!key) throw new InboxError("validation_error", "idempotency_key: required, one per press.", { field: "idempotency_key" });
  if (body.words !== undefined && body.words !== null && typeof body.words !== "string") throw new InboxError("validation_error", "words: a string.", { field: "words" });
  const words = typeof body.words === "string" ? body.words : "";
  const listed = body.comment_ids ?? [];
  if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string")) throw new InboxError("validation_error", "comment_ids: a list of comment ids.", { field: "comment_ids" });
  const ids = listed as string[];
  if (mode === "now" && ids.length === 0) throw new InboxError("validation_error", "comment_ids: the drafts a `now` send sends.", { field: "comment_ids" });
  const root = store.message(threadId);
  if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);

  // The person's reply this press wrote its words in, if it did (found by the key, whichever message it answered).
  const wordsWritten = () => store.thread(threadId)?.messages.map((m) => store.message(m.id)).find((m) => m?.author.kind === "person" && m.idempotency_key === key) ?? null;
  const done = store.commentSendsByKey(threadId, key);
  if (done.length > 0) {
    if (done[0]!.mode !== mode || ids.some((id) => !done.some((send) => send.comments.includes(id)))) {
      throw new InboxError("idempotency_key_reused", "This idempotency_key was already used for another press.");
    }
    return { sends: done, message: wordsWritten(), replayed: true };
  }

  const drafts = mode === "now" ? namedDrafts(store, threadId, ids) : store.pendingAnnotations(threadId).filter(isInboxCommentSendable);
  for (const draft of drafts) {
    if (!store.messageAnswerable(draft.message_id)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to send.");
  }
  const messages = store.thread(threadId)?.messages ?? [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const wordsAt = inboxWordsMessage(messages);
  const wordsTo = wordsAt ? inboxCommentSendAddress(wordsAt) : null;
  if (mode === "round" && wordsAt && !store.messageAnswerable(wordsAt.id)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to send.");
  const groups = inboxCommentSendRoutes(drafts, (id) => byId.get(id), wordsTo);
  const sent = store.sentAnnotations(threadId);
  const sends = store.commentSends(threadId);
  const replies = store.commentReplies(threadId);
  const round = inboxCommentRoundNow(messages, sent, sends, replies);
  if (mode === "round") {
    // A Finish ends the round for every session the round's sends reached, and for the one the words go to, drafts or none.
    const rounds = inboxCommentRounds(messages, sent, sends, replies);
    const reached = [...sends.filter((send) => rounds.get(send.id) === round).map((send) => send.to), ...(wordsTo ? [wordsTo] : [])];
    for (const to of reached) {
      if (groups.some((group) => group.to?.session === to.session && group.to.host === to.host)) continue;
      // Before the words' group, which stays last.
      const words = wordsTo && groups.at(-1)?.to?.session === wordsTo.session && groups.at(-1)?.to?.host === wordsTo.host ? groups.pop() : undefined;
      groups.push({ to: { host: to.host, session: to.session }, drafts: [] }, ...(words ? [words] : []));
    }
  }
  if (groups.length === 0 || groups.some((group) => group.to === null)) {
    throw new InboxError("not_addressed", "No agent session wrote in this thread to send these comments to.");
  }
  const addressed = groups as { to: InboxCommentSend["to"]; drafts: InboxAnnotationRecord[] }[];

  // A Finish names, to each session, the threads still open that went to it before (their words are not sent again).
  const sentTo = (carrier: string): string | null => {
    const send = store.commentSend(carrier);
    if (send) return send.to.session;
    const reply = store.message(carrier);
    return reply && !reply.reask ? (store.recipientOf(reply)?.session ?? null) : null;
  };
  const threads = mode === "round" ? inboxCommentThreads(messages, sent, store.commentReplies(threadId), sends) : [];
  const named = (session: string) =>
    inboxOpenCommentsToName(threads, session, sentTo)
      .filter((thread) => !store.commentCarrierClosedByArchive(thread.reply_id))
      .map((thread) => thread.id);
  // The `@` tags of the comments each send carries, checked before anything is written.
  const tagsOf = (group: (typeof addressed)[number]): InboxTag[] => {
    const sessions = [...new Set(group.drafts.flatMap(mentionsOf))].filter((session) => session !== group.to.session);
    return sessions.length > 0 && context.tagTargets ? context.tagTargets(sessions.map((session) => ({ session }))) : [];
  };
  const planned = addressed.map((group) => ({ to: group.to, tags: tagsOf(group), drafts: group.drafts.map((draft) => draft.id), named: mode === "round" ? named(group.to.session) : [] }));

  // The words, as the person's reply to the message they answer (a retry finds the one it wrote).
  let message: InboxMessage | null = null;
  if (words.trim() !== "") {
    if (!wordsAt || !store.messageAnswerable(wordsAt.id)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to send.");
    message = wordsWritten() ?? store.sendReply(wordsAt.id, { words, idempotency_key: key }).reply;
  }
  const carrier = message ? store.recipientOf(message)?.session : undefined;
  const written = store.writeCommentSends(threadId, {
    mode: mode as InboxCommentSendMode,
    round,
    idempotency_key: key,
    sends: planned.map((send) => ({ ...send, with_message: message && send.to.session === carrier ? message.id : null })),
  });
  return { sends: written, message, replayed: false };
}

/** The drafts a `now` send names: each this thread's, waiting, never a guided review's, named once. */
function namedDrafts(store: InboxStore, threadId: string, ids: readonly string[]): InboxAnnotationRecord[] {
  const seen = new Set<string>();
  return ids.map((id, index) => {
    const field = `comment_ids[${index}]`;
    const record = store.annotation(id);
    if (!record || record.thread_id !== threadId) throw new InboxError("annotation_not_found", `${field}: no comment ${id} in this thread.`, { field });
    if (record.removed_at !== null || record.sent_reply_id !== null) throw new InboxError("annotation_closed", `${field}: ${id} was already sent or removed.`, { field });
    if (!isInboxCommentSendable(record)) throw new InboxError("validation_error", `${field}: a guided review's comment goes with your verdict.`, { field });
    if (seen.has(id)) throw new InboxError("validation_error", `${field}: listed twice.`, { field });
    seen.add(id);
    return record;
  });
}

/**
 * The person's reply just saved under a comment (the reply route, any
 * client): under a live thread it goes on its own, as a `now` send, and the
 * answer is the reply as sent with its sends. A refusal (a tag that cannot
 * be reached) leaves it a draft and says why (`send_refused`).
 */
export function liveCommentReply(
  context: InboxCommentSendsContext,
  record: InboxAnnotationRecord,
): { annotation: InboxAnnotationRecord; sends?: InboxCommentSend[]; send_refused?: { code: string; message: string } } {
  const { store } = context;
  const live = inboxLiveCommentThreads(store.commentSends(record.thread_id), store.sentAnnotations(record.thread_id));
  if (!inboxCommentDraftIsLive(record, live)) return { annotation: record };
  try {
    const { sends } = sendComments(context, record.thread_id, { mode: "now", comment_ids: [record.id], idempotency_key: `live:${record.id}` });
    return { annotation: store.annotation(record.id) ?? record, sends };
  } catch (error) {
    if (!(error instanceof InboxError)) throw error;
    return { annotation: record, send_refused: { code: error.code, message: error.message } };
  }
}

/**
 * The reply route's save sent again after its reply went on its own (a lost
 * answer, a client's retry): the same id, under the same comment, with the
 * same words, answers the reply as sent and its send; anything else is the
 * store's to judge (null).
 */
export function liveCommentReplyAgain(context: InboxCommentSendsContext, commentId: string, annotation: Record<string, unknown>): { annotation: InboxAnnotationRecord; sends: InboxCommentSend[]; replayed: true } | null {
  const { store } = context;
  const record = typeof annotation.id === "string" ? store.annotation(annotation.id) : null;
  const send = record?.sent_reply_id ? store.commentSend(record.sent_reply_id) : null;
  if (!record || !send || send.idempotency_key !== `live:${record.id}` || record.removed_at !== null) return null;
  const words = typeof annotation.text === "string" ? annotation.text.trim() : "";
  if (words !== record.annotation.text || store.sentComment(commentId).id !== record.re) return null;
  return { annotation: record, sends: [send], replayed: true };
}

/** The route (see the header), answered only while sent comments stay in view. */
export function createInboxCommentSendRoutes(options: InboxCommentSendsContext & {
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (data: unknown, status?: number) => Response;
  persistentCommentsOn: () => boolean;
}) {
  const { serverSession, readBody, json, persistentCommentsOn } = options;
  const route = async (req: Request, path: string): Promise<Response | null> => {
    const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/comment-sends$/.exec(path);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!persistentCommentsOn()) return json({ error: "Sent comments are not kept in view.", code: "persistent_comments_off" }, 409);
    const body = await readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    return json(sendComments(options, match[1]!, body));
  };
  return {
    route,
    liveReply: (record: InboxAnnotationRecord) => liveCommentReply(options, record),
    liveReplyAgain: (commentId: string, annotation: Record<string, unknown>) => liveCommentReplyAgain(options, commentId, annotation),
  };
}
