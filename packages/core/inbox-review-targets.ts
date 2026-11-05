/**
 * Plannotator Inbox: review targets (experimental "persistent-comments").
 *
 * The person drops something to review into the Inbox for one agent session:
 * a message of that agent's chat, or a file on this computer. It lands in a
 * thread of its own, one per session and target (the chat, each file), taken
 * up again while it is open and new once the person resolved it. A chat
 * message is written as a message of that agent, so it takes comments and a
 * Send wakes that session; it is marked `imported`, so it is never the
 * session's default thread and never reads as the agent's answer or activity
 * (`isInboxAgentOwn`: the row's Sent and last word, its unread count, a
 * notification, the session's last thread). A file is attached, by path, to a
 * short message of that agent.
 *
 * The rules are here, pure and browser-safe; the route is
 * packages/server/inbox-review-targets.ts, the command
 * apps/hook/server/inbox-review-command.ts. Re-exported by `inbox-types`.
 */

/** Who dropped it: the window, a process on this computer (`plannotator inbox review`), or a paired device. */
export type InboxImportedBy = { kind: "window" } | { kind: "cli" } | { kind: "device"; id: string };

/**
 * On an agent's message the person dropped into a review thread
 * (`InboxMessage.imported`): the words are the agent's, the message is not one
 * it sent. Additive: a reader that does not know the field sees the agent's message.
 */
export interface InboxImported {
  /** The agent's chat (its host's transcript), or a file on this computer. */
  from: "transcript" | "file";
  /** Chat: the message's id in its host's transcript, when the caller knew it. */
  host_message_id?: string | null;
  /** Chat: the sha256 of its words, blind to spacing (`inboxReviewWords`). */
  sha256?: string;
  /** Chat: the Inbox found these words in the session's transcript; false when it could not read one, or did not find them. */
  verified?: boolean;
  /** File: its realpath, the thread's key. */
  path?: string;
  by: InboxImportedBy;
}

/** What a caller drops. */
export type InboxReviewTarget = { kind: "chat_message"; text: string; host_message_id: string | null } | { kind: "file"; path: string };

/** One assistant message of a host's transcript, as the Inbox could read it. */
export interface InboxHostMessage {
  id: string;
  text: string;
}

/** The fields of a message these rules read. */
interface ReviewMessage {
  id: string;
  author: { kind: string; session?: string | null };
  resolved_at?: string | null;
  imported?: InboxImported | null;
  idempotency_key?: string | null;
  attachments?: readonly { id: string; path: string }[];
}

/** A message the person dropped for review: never the agent's own answer. */
export function isInboxImported(message: { author: { kind: string }; imported?: unknown }): boolean {
  return message.author.kind === "agent" && typeof message.imported === "object" && message.imported !== null;
}

/** An agent's message it sent itself: its answer, its activity, its last word (never what the person dropped). */
export function isInboxAgentOwn<T extends { author: { kind: string }; imported?: unknown }>(message: T): message is T & { author: Extract<T["author"], { kind: "agent" }> } {
  return message.author.kind === "agent" && !isInboxImported(message);
}

/**
 * The words of a text as the fingerprint and the transcript check compare
 * them: one space for each run of white space, none at the ends. Two clients
 * that join a message's text blocks differently drop it once.
 */
export function inboxReviewWords(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The thread a target goes in, for its session: one for the chat, one per file (its realpath). */
export function inboxReviewThreadKey(imported: Pick<InboxImported, "from" | "path">): string {
  return imported.from === "file" ? `file:${imported.path ?? ""}` : "chat";
}

/**
 * The open review thread of `session` for `key`: the newest root the person
 * dropped for that session and target that is not resolved. `roots` oldest
 * first. Null: a new thread.
 */
export function inboxReviewThreadOf<T extends ReviewMessage>(roots: readonly T[], session: string, key: string): T | null {
  for (let i = roots.length - 1; i >= 0; i--) {
    const root = roots[i]!;
    if (!isInboxImported(root) || root.author.session !== session || inboxReviewThreadKey(root.imported!) !== key) continue;
    if (root.resolved_at == null) return root;
  }
  return null;
}

/** A target as these rules compare it: a chat message by its host id and words, a file by its realpath. */
export type InboxReviewKey = { from: "transcript"; host_message_id: string | null; sha256: string } | { from: "file"; path: string };

/** Whether a dropped message is that very target (an idempotency key used again for it, and not for another). */
export function inboxReviewSameTarget(imported: InboxImported, target: InboxReviewKey): boolean {
  if (target.from === "file") return imported.from === "file" && imported.path === target.path;
  return imported.from === "transcript" && imported.sha256 === target.sha256 && (imported.host_message_id ?? null) === target.host_message_id;
}

/**
 * What is already in the open review thread for this target, so nothing is
 * written: a chat message with the same host id and words; the last one
 * dropped when its words are the same and one of the two has no host id (two
 * ids that differ are two messages); a file, its message. `messages` in
 * thread order.
 */
export function inboxReviewDuplicate<T extends ReviewMessage>(messages: readonly T[], target: InboxReviewKey): T | null {
  const dropped = messages.filter(isInboxImported);
  if (target.from === "file") return dropped.find((m) => m.imported!.from === "file" && m.imported!.path === target.path) ?? null;
  const chat = dropped.filter((m) => m.imported!.from === "transcript");
  if (target.host_message_id) {
    const same = chat.find((m) => m.imported!.host_message_id === target.host_message_id && m.imported!.sha256 === target.sha256);
    if (same) return same;
  }
  const last = chat.at(-1);
  return last && last.imported!.sha256 === target.sha256 && (!target.host_message_id || !last.imported!.host_message_id) ? last : null;
}

/** A drop already answered for this idempotency key, in the session's review threads. */
export function inboxReviewReplay<T extends ReviewMessage>(messages: readonly T[], session: string, key: string): T | null {
  return messages.find((m) => isInboxImported(m) && m.author.session === session && m.idempotency_key === key) ?? null;
}

/**
 * Whether a text is the agent's, by its host's transcript (oldest first):
 * the message `hostMessageId` names, when the transcript has it; otherwise
 * one message, or a run of consecutive ones (a turn's words split into
 * several messages), with the same words. Null transcript (not readable): false.
 */
export function inboxReviewVerified(text: string, hostMessageId: string | null, transcript: readonly InboxHostMessage[] | null): boolean {
  if (!transcript) return false;
  const words = inboxReviewWords(text);
  if (!words) return false;
  const named = hostMessageId ? transcript.find((m) => m.id === hostMessageId) : undefined;
  if (named) return inboxReviewWords(named.text) === words;
  for (let end = transcript.length - 1; end >= 0; end--) {
    let run = "";
    for (let start = end; start >= 0; start--) {
      const part = inboxReviewWords(transcript[start]!.text);
      if (!part) continue;
      run = run ? `${part} ${run}` : part;
      if (run === words) return true;
      if (run.length >= words.length) break;
    }
  }
  return false;
}

/** The window's address of what was dropped: the message, or the file beside its thread. */
export function inboxReviewTargetUrl(base: string, threadId: string, at: { message_id: string } | { attachment_id: string }): string {
  const params = new URLSearchParams();
  params.set("thread", threadId);
  if ("attachment_id" in at) params.set("file", at.attachment_id);
  else params.set("msg", at.message_id);
  return `${base}#${params.toString()}`;
}
