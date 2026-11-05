/**
 * The window's side of review targets (experimental "persistent-comments"):
 * a thread the person dropped a message or a file into is not news to them.
 * It raises no new-thread notification, and the dropped message is not
 * "new since you looked". An agent's own message still is both.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxMessage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { newSinceLook } from './folding';
import { isNewAgentThread } from './notify';

const agent = { kind: 'agent' as const, host: 'claude-code', session: 'ses-a', name: 'Claude Code' };
const imported = { from: 'transcript' as const, sha256: 'a'.repeat(64), host_message_id: null, by: { kind: 'cli' as const } };
const message = (id: string, seq: number, over: Partial<InboxMessage> = {}) =>
  ({
    id,
    project_id: 'prj_1',
    thread_id: 'msg_1',
    reply_to: null,
    author: agent,
    subject: id === 'msg_1' ? 'Review of the chat' : null,
    body: 'The backoff is now 2, 4 and 8 seconds.',
    created_at: '2026-11-05T10:00:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    seq,
    ...over,
  }) as InboxMessageWire;

describe('a review thread the person dropped into', () => {
  test('raises no new-thread notification; an agent-started thread does', () => {
    expect(isNewAgentThread(message('msg_1', 1, { imported }), true, new Set())).toBe(false);
    expect(isNewAgentThread(message('msg_1', 1), true, new Set())).toBe(true);
  });

  test('its dropped messages are not new since the look; the agent\'s own message after them is', () => {
    const messages = [message('msg_1', 5, { imported }), message('msg_2', 6, { imported }), message('msg_3', 7)];
    expect([...newSinceLook(messages, 4)]).toEqual(['msg_3']);
  });
});
