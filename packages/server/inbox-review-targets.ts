/**
 * Plannotator Inbox: review targets (experimental "persistent-comments").
 * The person's "open a review thread on this text or this file, for this
 * session": the one operation `/plannotator-last`, `/plannotator-annotate`
 * and the terminal clients call (through `plannotator inbox review`,
 * apps/hook/server/inbox-review-command.ts, or this route). The rules are in
 * core inbox-review-targets.ts.
 *
 *   POST /api/inbox/review-targets
 *     { session: "<host>:<id>", project_path?, target, idempotency_key }
 *     target: { kind: "chat_message", text, host_message_id? } | { kind: "file", path }
 *     → { thread_id, message_id, attachment_id?, created, verified?, url }
 *
 * - The session must be live (409 `session_not_live`, nothing written).
 * - One thread per session and target, taken up while open, new once resolved.
 * - A chat message is written as the session's agent's message, marked
 *   `imported` (the transcript's id, the words' sha256, whether the session's
 *   transcript has them, who dropped it). The same id and words, or without
 *   an id the same words as the last one dropped there, write nothing and
 *   answer the message already there (`created: false`).
 * - A file is attached by path under a short message of the agent; already
 *   there, nothing is written.
 * - An idempotency_key used before answers what it answered.
 * - The window's own route (same origin and serverSession), the owner's
 *   only; a process on this computer reaches it as the window's routes, with
 *   no Origin. The device door can call `deposit` with the device as `by`.
 * - It never opens a tab: `plannotator inbox review --open` does, for the
 *   person who asked.
 * - Off (the switch), 409 `persistent_comments_off` and nothing changes.
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  INBOX_HOST_NAMES,
  inboxReviewDuplicate,
  inboxReviewReplay,
  inboxReviewTargetUrl,
  inboxReviewThreadKey,
  inboxReviewThreadOf,
  inboxReviewVerified,
  inboxReviewWords,
  isInboxImported,
  parseInboxSessionRef,
  type InboxHostMessage,
  type InboxImported,
  type InboxImportedBy,
  type InboxMessage,
  type InboxProject,
  type InboxReviewTarget,
} from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { createInboxLiveSessions } from "./inbox-sessions";

export const INBOX_REVIEW_TARGETS_PATH = "/api/inbox/review-targets";

/** What a drop answers. */
export interface InboxReviewDeposit {
  thread_id: string;
  message_id: string;
  attachment_id?: string;
  /** False: it was there already, nothing was written. */
  created: boolean;
  /** A chat message: whether the session's transcript has these words. */
  verified?: boolean;
  /** The window's address of the message, or of the file beside its thread. */
  url: string;
}

const field = (name: string, message: string) => new InboxError("validation_error", `${name}: ${message}`, { field: name });

/** The target as the body names it, or a refusal. */
function targetOf(value: unknown): InboxReviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw field("target", "{ kind: \"chat_message\", text } or { kind: \"file\", path }.");
  const target = value as Record<string, unknown>;
  if (target.kind === "chat_message") {
    if (typeof target.text !== "string" || !inboxReviewWords(target.text)) throw field("target.text", "the message's words.");
    const id = target.host_message_id;
    if (id !== undefined && id !== null && (typeof id !== "string" || !id.trim() || id.length > 200)) throw field("target.host_message_id", "the message's id in its host's transcript.");
    return { kind: "chat_message", text: target.text, host_message_id: typeof id === "string" ? id.trim() : null };
  }
  if (target.kind === "file") {
    if (typeof target.path !== "string" || !target.path.trim()) throw field("target.path", "the file's path.");
    return { kind: "file", path: target.path };
  }
  throw field("target.kind", "chat_message or file.");
}

export function createInboxReviewTargets(options: {
  store: InboxStore;
  serverSession: string;
  live: ReturnType<typeof createInboxLiveSessions>;
  /** A folder to its project (realpath, git toplevel), created on first use: send_message's resolver. */
  resolveProject: (path: string) => Promise<InboxProject>;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  baseUrl: () => string;
  /** The switch (experimental "persistent-comments"). */
  on: () => boolean;
  /** Whether the person's reply wakes that session (its connection polls now). */
  wakes: (host: string, session: string) => boolean;
  /** The assistant messages of a session's transcript, oldest first; null when this Inbox cannot read that host's. Absent: never. */
  readHostMessages?: (host: string, session: string) => Promise<readonly InboxHostMessage[] | null>;
  now?: () => Date;
}) {
  const { store, live, json } = options;
  const now = options.now ?? (() => new Date());

  /** The roots of the threads dropped for `session`, oldest first. */
  const reviewRoots = (session: string): InboxMessage[] =>
    store
      .threadIds()
      .map((id) => store.message(id)!)
      .filter((root) => isInboxImported(root) && root.author.kind === "agent" && root.author.session === session);
  const threadMessages = (threadId: string): InboxMessage[] => store.threadMessageIds(threadId).map((id) => store.message(id)!);

  const answer = (message: InboxMessage, created: boolean): InboxReviewDeposit => {
    const imported = message.imported!;
    const attachment = imported.from === "file" ? message.attachments?.find((a) => a.path === imported.path) : undefined;
    return {
      thread_id: message.thread_id,
      message_id: message.id,
      ...(attachment ? { attachment_id: attachment.id } : {}),
      created,
      ...(imported.from === "transcript" ? { verified: imported.verified === true } : {}),
      url: inboxReviewTargetUrl(options.baseUrl(), message.thread_id, attachment ? { attachment_id: attachment.id } : { message_id: message.id }),
    };
  };

  /** The session's project: where it works, else where it last wrote, else the caller's folder. */
  const projectOf = async (root: string | null, session: string, projectPath: unknown): Promise<InboxProject> => {
    if (root !== null) return options.resolveProject(root);
    const wrote = store.lastThreadsBySession().get(session);
    const project = wrote ? store.project(wrote.project_id) : null;
    if (project) return project;
    if (typeof projectPath === "string" && isAbsolute(projectPath)) return options.resolveProject(projectPath);
    throw new InboxError("session_not_live", "That session has not said where it works yet; try again in a moment.");
  };

  /** The file a target names, by its realpath; relative to `project_path` when not absolute. */
  const fileOf = (path: string, projectPath: unknown): string => {
    const base = typeof projectPath === "string" && isAbsolute(projectPath) ? projectPath : null;
    if (!isAbsolute(path) && !base) throw field("target.path", "an absolute path (or one relative to project_path).");
    try {
      const real = realpathSync(base ? resolve(base, path) : path);
      if (statSync(real).isFile()) return real;
    } catch {
      // Answered below.
    }
    throw field("target.path", `${path}: no such file.`);
  };

  /** Drop a target for a session (the route's body), as `by`. */
  const dropNow = async (body: Record<string, unknown>, by: InboxImportedBy): Promise<InboxReviewDeposit> => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key) throw field("idempotency_key", "required.");
    const ref = typeof body.session === "string" ? parseInboxSessionRef(body.session.trim()) : null;
    if (!ref) throw field("session", "<host>:<id> of a live session.");
    const target = targetOf(body.target);
    // A replayed call answers what it answered, whatever the session's state now.
    const replay = inboxReviewReplay(reviewRoots(ref.session).flatMap((root) => threadMessages(root.id)), ref.session, key);
    if (replay) return answer(replay, false);
    const asked = live.composeTarget({ session: ref.session, ...(ref.host ? { host: ref.host } : {}) });
    if (!asked) throw new InboxError("session_not_live", "That session is not live: nothing was dropped.");

    const path = target.kind === "file" ? fileOf(target.path, body.project_path) : null;
    let imported: InboxImported =
      target.kind === "file"
        ? { from: "file", path: path!, by }
        : { from: "transcript", host_message_id: target.host_message_id, sha256: createHash("sha256").update(inboxReviewWords(target.text)).digest("hex"), by };
    const open = inboxReviewThreadOf(reviewRoots(asked.session), asked.session, inboxReviewThreadKey(imported));
    const there = open
      ? inboxReviewDuplicate(threadMessages(open.id), path ? { from: "file", path } : { from: "transcript", host_message_id: imported.host_message_id ?? null, sha256: imported.sha256! })
      : null;
    if (there) return answer(there, false);

    const project = open ? store.project(open.project_id)! : await projectOf(asked.root, asked.session, body.project_path);
    let text: string;
    let attachments: Awaited<ReturnType<typeof recordInboxAttachments>> | undefined;
    if (path) {
      attachments = await recordInboxAttachments(store.dir, [path], { base: project.root, at: now().toISOString() });
      const inside = relative(project.root, path);
      text = `\`${inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? inside : path}\``;
    } else {
      text = (target as Extract<InboxReviewTarget, { kind: "chat_message" }>).text;
      const transcript = options.readHostMessages ? await options.readHostMessages(asked.host, asked.session).catch(() => null) : null;
      imported = { ...imported, verified: inboxReviewVerified(text, imported.host_message_id ?? null, transcript) };
    }
    const result = store.sendMessage({
      project_id: project.id,
      author: { kind: "agent", host: asked.host, session: asked.session, name: INBOX_HOST_NAMES[asked.host] ?? null },
      body: text,
      subject: attachments?.[0] ? `Review of ${attachments[0].name}` : "Review of the chat",
      idempotency_key: key,
      ...(attachments ? { attachments } : {}),
      ...(options.wakes(asked.host, asked.session) ? { wakes: true } : {}),
      imported: { record: imported, thread_id: open?.id ?? null },
    });
    return answer(result.message, !result.replayed);
  };

  // One drop at a time: two calls for the same target never make two threads.
  let queue: Promise<unknown> = Promise.resolve();
  const deposit = (body: Record<string, unknown>, by: InboxImportedBy): Promise<InboxReviewDeposit> => {
    const next = queue.then(() => dropNow(body, by));
    queue = next.catch(() => {});
    return next;
  };

  /**
   * The window's route; null when the path is not it. `owner`: this computer's
   * owner asks (this computer, the owner's tailnet login): only they drop
   * words in an agent's name.
   */
  const route = async (req: Request, url: URL, owner: boolean): Promise<Response | null> => {
    if (url.pathname !== INBOX_REVIEW_TARGETS_PATH) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!options.on()) return json({ error: "Review threads need sent comments kept in view (Settings → Capabilities → Experimental).", code: "persistent_comments_off" }, 409);
    if (!owner) throw new InboxError("owner_only", "Only this computer's owner can drop a review target.");
    const body = await options.readBody(req);
    if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    // A page sends its Origin on every POST; a process on this computer sends none.
    const by: InboxImportedBy = req.headers.get("origin") !== null ? { kind: "window" } : { kind: "cli" };
    return json(await deposit(body, by));
  };

  return { route, deposit };
}
