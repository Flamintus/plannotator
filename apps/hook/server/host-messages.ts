/**
 * Host messages side channel for `annotate-last --stdin`.
 *
 * A host that starts the CLI detached (the Claude Code mod in
 * `apps/hook/hooks/mod/`) has no transcript file for the CLI to read, so it
 * hands the newest assistant text over on stdin. That alone loses the message
 * picker the classic path offers. When the host also sets
 * `PLANNOTATOR_HOST_MESSAGES_FILE` to a `messages.json` it wrote, the CLI
 * reads the recent assistant messages from it instead:
 *
 *   { "v": 1, "messages": [{ "messageId": "…", "text": "…", "timestamp"?: "…" }] }
 *
 * newest first, index 0 opened by default. Why a variable and not a new flag:
 * a CLI that predates this ignores the variable and still reads the newest
 * text from stdin (today's behavior), while an unknown flag would either be
 * ignored silently (a different code path) or read the JSON as the message.
 *
 * The variable is taken once at startup and removed from `process.env`, like
 * the host result file, so nothing the server spawns inherits it.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { MAX_HOST_MESSAGES_FILE_BYTES, parseHostMessages, type HostMessagesParse } from "@plannotator/shared/host-messages";

export {
  MAX_HOST_MESSAGE_BYTES,
  MAX_HOST_MESSAGES,
  MAX_HOST_MESSAGES_FILE_BYTES,
  parseHostMessages,
  type HostMessage,
  type HostMessagesParse,
} from "@plannotator/shared/host-messages";

export const HOST_MESSAGES_FILE_ENV = "PLANNOTATOR_HOST_MESSAGES_FILE";

let takenPath: string | undefined;
let taken = false;

/** Only a `messages.json` inside the mod's launch area of the data dir is read. */
export function isAllowedHostMessagesPath(path: string, dataDir: string = getPlannotatorDataDir()): boolean {
  if (!isAbsolute(path) || basename(path) !== "messages.json") return false;
  const root = resolve(dataDir, "claude-code-mod") + sep;
  return resolve(path).startsWith(root);
}

/** Read the side-channel path once and scrub it from the environment. */
export function takeHostMessagesPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!taken) {
    taken = true;
    const value = env[HOST_MESSAGES_FILE_ENV];
    delete env[HOST_MESSAGES_FILE_ENV];
    const path = value && value.trim() ? value : undefined;
    if (path && !isAllowedHostMessagesPath(path)) {
      console.error(`Plannotator: ignoring ${HOST_MESSAGES_FILE_ENV}: not a messages.json under the data dir's claude-code-mod/ folder.`);
      takenPath = undefined;
    } else {
      takenPath = path;
    }
  }
  return takenPath;
}

function fail(error: string): HostMessagesParse {
  return { ok: false, error: `invalid host messages: ${error}` };
}

/** Read and validate the file the host wrote. */
export function readHostMessages(path: string): HostMessagesParse {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return fail("not a regular file");
    size = stat.size;
  } catch {
    return fail("file not found");
  }
  if (size > MAX_HOST_MESSAGES_FILE_BYTES) return fail("file is too large");
  try {
    return parseHostMessages(readFileSync(path, "utf8"));
  } catch {
    return fail("file could not be read");
  }
}
