/**
 * The recent assistant messages a host hands the `last` screen (newest
 * first, the picker's list): `{ v: 1, messages: [{ messageId, text,
 * timestamp? }] }`, validated fail-closed. The CLI reads them from the file
 * the Claude Code mod writes (`PLANNOTATOR_HOST_MESSAGES_FILE`,
 * apps/hook/server/host-messages.ts); an open `last` screen gets the agent's
 * next ones from the host (`POST /api/host/messages`, review-loop.ts).
 *
 * Runtime-agnostic (vendored to Pi).
 */

export interface HostMessage {
  messageId: string;
  text: string;
  timestamp?: string;
}

/** The picker's own limit on the classic path (RECENT_MESSAGES_LIMIT). */
export const MAX_HOST_MESSAGES = 25;
/** Per message, in UTF-8 bytes. */
export const MAX_HOST_MESSAGE_BYTES = 2 * 1024 * 1024;
/** The whole file, in bytes. */
export const MAX_HOST_MESSAGES_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;

export type HostMessagesParse = { ok: true; messages: HostMessage[] } | { ok: false; error: string };

function fail(error: string): HostMessagesParse {
  return { ok: false, error: `invalid host messages: ${error}` };
}

/**
 * Validate the payload fail-closed: version 1, 1..25 messages, string fields
 * only, bounded sizes, non-empty text, unique ids. Error text never quotes the
 * payload.
 */
export function parseHostMessages(text: string): HostMessagesParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  return readHostMessagesValue(value);
}

/** The same checks on a value already parsed (a host's request body). */
export function readHostMessagesValue(value: unknown): HostMessagesParse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected an object");
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return fail("unsupported version");
  const list = record.messages;
  if (!Array.isArray(list)) return fail("messages must be an array");
  if (list.length === 0) return fail("no messages");
  if (list.length > MAX_HOST_MESSAGES) return fail(`more than ${MAX_HOST_MESSAGES} messages`);
  const seen = new Set<string>();
  const messages: HostMessage[] = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail(`message ${index} is not an object`);
    const entry = item as Record<string, unknown>;
    const { messageId, text: body, timestamp } = entry;
    if (typeof messageId !== "string" || !messageId || messageId.length > MAX_ID_LENGTH) {
      return fail(`message ${index} has no valid messageId`);
    }
    if (seen.has(messageId)) return fail(`duplicate messageId at ${index}`);
    seen.add(messageId);
    if (typeof body !== "string" || !body.trim()) return fail(`message ${index} has no text`);
    if (Buffer.byteLength(body, "utf8") > MAX_HOST_MESSAGE_BYTES) return fail(`message ${index} is too large`);
    if (timestamp !== undefined && (typeof timestamp !== "string" || timestamp.length > MAX_TIMESTAMP_LENGTH)) {
      return fail(`message ${index} has an invalid timestamp`);
    }
    messages.push({ messageId, text: body, ...(timestamp ? { timestamp } : {}) });
  }
  return { ok: true, messages };
}
