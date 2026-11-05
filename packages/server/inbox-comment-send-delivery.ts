/**
 * The person's comment sends on the wake (experimental "persistent-comments"):
 * a send waits for its session beside the person's replies
 * (`InboxStore.pendingWakeItems`), and the same wake hands it over, worded by
 * the server, never by the window (packages/core/inbox-comment-sends.ts
 * composes the text from the records).
 *
 * - A command that delivers sends stays a `reply`, with `comments`
 *   (`{ sends, round, mode, count }`): comments alone under the oldest
 *   send's id, which `reply_to` takes (`commentSendReplyTarget`); with the
 *   person's words, the words' message's command, its text after the words.
 *   An older connection ignores the field and delivers it as a reply.
 * - The text: each entry as read_thread places it, plus what the server
 *   knows that the record does not say (a document comment's lines in the
 *   version commented, read from that version's text), the record's notes
 *   (a diagram part, an HTML element, attached images, the agents it tags),
 *   then one "Skills referenced" block for the words and the comments.
 * - `delivered` settles each send of the command's list (`sends`, posted
 *   back by a connection that takes a thread's sends together), its id
 *   alone otherwise; a message's delivery settles the sends its words carry.
 */

import {
  inboxCommentEntryNotes,
  inboxCommentSendMark,
  inboxCommentSendText,
  inboxCommentsWake,
  inboxQuoteLines,
  isInboxCommentSendId,
  type InboxCommentSend,
  type InboxWakeItem,
} from "@plannotator/core/inbox-comment-sends";
import { inboxCommentAnchor, isInboxCommentReply, isInboxSubThread, type InboxCommentEntryDetail } from "@plannotator/core/inbox-comment-threads";
import { INBOX_HOST_NAMES, INBOX_VIEW_MAX_BYTES, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxMessage } from "@plannotator/core/inbox-types";
import { inboxThreadHadReview } from "@plannotator/core/inbox-review";
import { INBOX_REPLY_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import { checkCurrent, readInboxAttachmentSent } from "@plannotator/shared/inbox/attachments";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { builtinSkillContent, composeInboxSkillsBlock, inboxSkillFilter, inboxSkillReferences } from "@plannotator/core/inbox-skills-block";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { SkillCatalogEntry, SkillExportContent } from "@plannotator/core/skill-references";
import { readFileSync } from "node:fs";
import { inboxSkillEntries } from "./inbox-skills";
import { readReferenceSkillContent } from "./review-skill-loader";

export interface InboxCommentSendDeliveryContext {
  store: InboxStore;
  /** The person's Code review and Shape switches: their skills are in the catalog while on. */
  codeReviewOn?: () => boolean;
  shapeOn?: () => boolean;
  /** The skills a comment may name, and a human-only one's SKILL.md. Default: the global skill folders. */
  skillCatalog?: () => SkillCatalogEntry[];
  skillContent?: (name: string) => SkillExportContent | undefined;
}

/** The most of a file a document comment's lines are looked up in. */
const LINES_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** A version's text (a document or plain text), or null when it cannot be read whole now. */
function versionText(store: InboxStore, record: InboxAnnotationRecord): string | null {
  const hit = store.attachment(record.attachment_id);
  if (!hit) return null;
  const kind = readInboxAttachmentKind(hit.attachment.kind);
  if (kind !== "markdown" && kind !== "text") return null;
  if (record.version === "current") {
    const check = checkCurrent(hit.attachment);
    if (!check.ok || check.stat.size > Math.min(LINES_TEXT_MAX_BYTES, INBOX_VIEW_MAX_BYTES)) return null;
    try {
      return readFileSync(hit.attachment.path, "utf8");
    } catch {
      return null;
    }
  }
  const bytes = readInboxAttachmentSent(store.dir, hit.attachment);
  return bytes && bytes.length <= LINES_TEXT_MAX_BYTES ? bytes.toString("utf8") : null;
}

/** The agent a session is, by its host's own name: these words go into another session's prompt. */
function hostName(host: string | null | undefined): string {
  return host && Object.hasOwn(INBOX_HOST_NAMES, host) ? INBOX_HOST_NAMES[host]! : "another agent";
}

/** A word that starts with `/` or `$`, the only way a text names a skill: no catalog is read without one. */
const SKILL_TRIGGER_RE = /(^|[\s(])[$/][A-Za-z0-9]/;

function skillsBlock(context: InboxCommentSendDeliveryContext, texts: readonly string[], reviewed: boolean): string {
  const written = texts.filter((text) => text.trim() !== "" && SKILL_TRIGGER_RE.test(text));
  if (written.length === 0) return "";
  let catalog: SkillCatalogEntry[];
  try {
    catalog = (context.skillCatalog ?? (() => inboxSkillEntries(context.codeReviewOn?.() === true, context.shapeOn?.() === true) as SkillCatalogEntry[]))().filter(inboxSkillFilter(reviewed));
  } catch {
    return "";
  }
  const refs = inboxSkillReferences(written, catalog);
  if (refs.length === 0) return "";
  const read = context.skillContent ?? ((name: string) => readReferenceSkillContent(name) ?? undefined);
  const contents = new Map<string, SkillExportContent>();
  for (const ref of refs.filter((entry) => entry.humanOnly)) {
    const content = builtinSkillContent(ref) ?? (ref.root === "plannotator" ? undefined : read(ref.name));
    if (content) contents.set(ref.name, { content: content.content, truncated: content.truncated, dir: content.dir, path: content.path });
  }
  return composeInboxSkillsBlock(refs, contents, INBOX_REPLY_SKILL_AUDIENCE);
}

/** The texts made lately, by what they were made from (the store's cursor, the sends, the words, the reader): a poll asks again every second while a command waits. */
const madeTexts = new Map<string, string>();
const MADE_TEXTS_KEPT = 32;

/**
 * What `receiver` reads of the sends one command delivers, after `words` (a
 * mixed send's message): `inboxCommentSendText` with each entry's lines and
 * notes, then the skills block the words and the comments name. The same
 * store state gives the same text, made once.
 */
export function commentSendsText(context: InboxCommentSendDeliveryContext, sends: readonly InboxCommentSend[], words = "", receiver: string | null = null): string {
  const key = [context.store.dir, context.store.cursor(), receiver ?? "", ...sends.map((send) => send.id), words].join("\0");
  const made = madeTexts.get(key);
  if (made !== undefined) return made;
  const text = makeCommentSendsText(context, sends, words, receiver);
  madeTexts.set(key, text);
  if (madeTexts.size > MADE_TEXTS_KEPT) madeTexts.delete(madeTexts.keys().next().value!);
  return text;
}

function makeCommentSendsText(context: InboxCommentSendDeliveryContext, sends: readonly InboxCommentSend[], words: string, receiver: string | null): string {
  const { store } = context;
  const threadId = sends[0]!.thread_id;
  const root = store.message(threadId);
  const projectRoot = (root ? store.project(root.project_id)?.root : null) ?? "";
  const records = store.sentAnnotations(threadId);
  const tags = sends.flatMap((send) => send.tags ?? []).filter((tag) => tag.session !== receiver);
  const tagNames = (sessions: readonly string[]) =>
    [...new Set(sessions.flatMap((session) => tags.filter((tag) => tag.session === session).map((tag) => tag.label?.trim() || hostName(tag.host))))];
  const texts = new Map<string, string | null>();
  const detail = (record: InboxAnnotationRecord): InboxCommentEntryDetail => {
    const notes = inboxCommentEntryNotes(record, tagNames);
    const anchor = inboxCommentAnchor(record);
    if (anchor.kind !== "file" || anchor.lines || anchor.at !== undefined || isInboxCommentReply(record) || isInboxSubThread(record)) return { notes };
    const quote = typeof record.annotation.originalText === "string" ? record.annotation.originalText : "";
    const key = `${record.attachment_id}\0${record.version}`;
    if (!texts.has(key)) texts.set(key, versionText(store, record));
    const text = texts.get(key);
    // Only words found once: a repeated quote could be any of its places.
    const lines = text && quote && text.indexOf(quote.trim()) === text.lastIndexOf(quote.trim()) ? inboxQuoteLines(text, quote) : null;
    return lines ? { notes, lines } : { notes };
  };
  const text = inboxCommentSendText({ sends, records, agentReplies: store.commentReplies(threadId), root: projectRoot, words, detail });
  const ids = new Set(sends.map((send) => send.id));
  const carried = records.filter((record) => record.sent_reply_id !== null && ids.has(record.sent_reply_id) && record.removed_at === null && !record.guide);
  const messages = (store.thread(threadId)?.messages ?? []).map((message) => store.message(message.id)).filter((message): message is InboxMessage => !!message);
  const block = skillsBlock(context, [words, ...carried.map((record) => (typeof record.annotation.text === "string" ? record.annotation.text : ""))], inboxThreadHadReview(messages));
  return block ? `${text}\n\n${block}` : text;
}

/** Whether a send's mark for `session` (its own, or its tag's) asks to go now. */
function sendNowAsked(send: InboxCommentSend, session: string): boolean {
  return !!inboxCommentSendMark(send, session)?.deliver_now_at;
}

/**
 * The command for one item of a session's wake: a message's own command
 * (`messageCommand`, the bridge's `replyCommand`) with the sends that ride
 * it, or the sends alone. `session`: who it goes to (the polling session).
 */
export function wakeCommandOf(
  context: InboxCommentSendDeliveryContext,
  item: InboxWakeItem,
  session: string | null,
  options: { sendNow: boolean; url: string; messageCommand: (message: InboxMessage) => InboxReplyCommand },
): InboxReplyCommand {
  const { store } = context;
  if (item.message && item.sends.length === 0) return options.messageCommand(item.message);
  const records = store.sentAnnotations(item.thread_id);
  // `read`: read_thread on the send's id shows what the sends carry (commentSendReadText), so a wake on them alone may leave them out.
  const comments = { ...inboxCommentsWake(item.sends, records), read: true };
  const receiver = session ?? item.sends[0]!.to.session;
  const now = options.sendNow && item.sends.some((send) => sendNowAsked(send, receiver)) ? { now: true } : {};
  if (item.message) {
    const command = options.messageCommand(item.message);
    return { ...command, body: commentSendsText(context, item.sends, command.body, receiver), comments, ...now };
  }
  const first = item.sends[0]!;
  const asked = store.thread(item.thread_id)?.messages.filter((message) => message.author.kind === "agent" && message.author.session === receiver).at(-1);
  return {
    type: "reply",
    id: item.id,
    thread_id: item.thread_id,
    reply_to: asked?.id ?? null,
    subject: store.threadShortName(item.thread_id) ?? store.threadSubject(item.thread_id),
    body: commentSendsText(context, item.sends, "", receiver),
    url: options.url,
    comments,
    // A session the comments tag, in a thread another session owns: the tagged wake.
    ...(first.to.session !== receiver ? { tagged: { owner: hostName(first.to.host) } } : {}),
    ...now,
  };
}

/** The sends a `delivered` names (`sends`), checked: comment send ids of the item's thread. */
function listedSends(store: InboxStore, threadId: string | null, value: unknown): string[] {
  if (!Array.isArray(value) || threadId === null) return [];
  return value.filter((id): id is string => isInboxCommentSendId(id) && store.commentSend(id)?.thread_id === threadId);
}

/**
 * A wake's item entered `by.session` (the bridge's `delivered`, a server-side
 * wake): a message's delivery (`recordDelivery`, which also settles the
 * sends its words carry), or the comment send's; and every send of the
 * command's list (`sends`). Refused for an item that is not this session's.
 */
export function recordWakeDelivery(
  store: InboxStore,
  id: string,
  by: { host: string; session: string; intoTurn?: boolean },
  sends: unknown,
  /** Sent comments are on: a message's delivery also settles the sends its words carry. */
  commentSends: boolean,
): { delivery: unknown } {
  if (!isInboxCommentSendId(id)) {
    // The sends the command named went in with it, whatever the message's own answer.
    try {
      return { delivery: store.recordDelivery(id, { ...by, commentSends }).delivery };
    } finally {
      store.recordCommentSendsDelivery(listedSends(store, store.message(id)?.thread_id ?? null, sends), by);
    }
  }
  const send = store.commentSend(id);
  if (!send) throw new InboxError("message_not_found", `No comment send ${id}.`);
  if (!inboxCommentSendMark(send, by.session)) throw new InboxError("validation_error", "session: this comment send goes to another session.", { field: "session" });
  const done = store.recordCommentSendsDelivery([id, ...listedSends(store, send.thread_id, sends)], by);
  return { delivery: inboxCommentSendMark(done.find((next) => next.id === id)!, by.session)?.delivery };
}

/**
 * Send now could not go into the running turn (`send_now_failed`): the mark
 * goes from the item's message and from every send it was handed with.
 */
export function clearWakeItemNow(store: InboxStore, id: string, session: string, commentSends: boolean): void {
  if (!isInboxCommentSendId(id)) store.clearDeliverNow(id, session);
  else if (!store.commentSend(id)) throw new InboxError("message_not_found", `No comment send ${id}.`);
  if (!commentSends) return;
  const item = store.pendingWakeItems(session, { tags: true, together: true, sends: true }).find((candidate) => candidate.id === id);
  for (const send of item?.sends ?? []) store.clearCommentSendNow(send.id, session);
  if (isInboxCommentSendId(id)) store.clearCommentSendNow(id, session);
}

/**
 * `reply_to` and `message_id` take a comment send's id (the wake names its
 * comments by it): the message it stands for, its words' message when it
 * carries some, else its thread's first. Any other value is returned as it is.
 */
export function commentSendReplyTarget(store: InboxStore, id: string | undefined, commentSends: boolean): string | undefined {
  if (!commentSends || !id || !isInboxCommentSendId(id.trim())) return id;
  const send = store.commentSend(id.trim());
  if (!send) throw new InboxError("message_not_found", `No message or comment send ${id}.`);
  return send.with_message ?? send.thread_id;
}

/**
 * What read_thread shows first when its `message_id` is a comment send's id
 * (a wake on comments alone names them by it and carries none of them: a
 * round is not a message): that send and the later ones of its thread to the
 * same session, as the wake used to carry them (`commentSendsText`: each
 * entry with its lines and notes, the threads still open, the skills block).
 * Null for any other id.
 */
export function commentSendReadText(context: InboxCommentSendDeliveryContext, id: string | undefined, reader: string | null): string | null {
  const named = id && isInboxCommentSendId(id.trim()) ? context.store.commentSend(id.trim()) : null;
  if (!named) return null;
  const sends = context.store.commentSends(named.thread_id).filter((send) => send.to.session === named.to.session && send.created_at >= named.created_at);
  return commentSendsText(context, sends, "", reader);
}

/**
 * Whether a comment send waiting alone goes to `session` through a
 * server-side wake of `host` (Codex, Qwen, T3): to its recipient when that
 * session's newest message in the thread woke, as a reply to it would; to a
 * session it tags when the tag wakes there.
 */
export function commentSendWakes(store: InboxStore, item: InboxWakeItem, session: string, host: string): boolean {
  const send = item.sends[0];
  if (!send) return false;
  if (send.to.session !== session) return send.tags?.some((tag) => tag.session === session && tag.host === host && tag.wakes) ?? false;
  if (send.to.host !== host) return false;
  const asked = store.thread(item.thread_id)?.messages.filter((message) => message.author.kind === "agent" && message.author.session === session).at(-1);
  return !!asked && store.message(asked.id)?.wakes === true;
}
