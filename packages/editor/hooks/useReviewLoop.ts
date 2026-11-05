/**
 * The review loop of an open screen (`/plannotator-last`,
 * `/plannotator-annotate`, plan review; #1116, experimental
 * "persistent-comments"): its state, read once from `GET /api/threads` and
 * then from the `review-threads` event (`receive`), and the page's writes
 * (`POST /api/threads/send`, `POST /api/threads/resolve`).
 *
 * Unavailable (the setting off, no host that carries sends, a target the
 * journal does not name), `state` stays null and the page is today's: one
 * extra read at load, nothing else.
 *
 * The page keeps per tab (sessionStorage, by review): the agent's replies the
 * person has looked at (the rest are "New"), where a sub-thread draft's
 * passage starts, and each send's key, so a send the host could not deliver
 * is handed over again by the same key (the server writes nothing twice).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_REVIEW_LOOP_INDEX, indexReviewLoop, readReviewLoopState, type ReviewLoopCommentInput, type ReviewLoopIndex, type ReviewLoopState } from '../reviewLoop';

export const REVIEW_THREADS_URL = '/api/threads';
export const REVIEW_THREADS_SEND_URL = '/api/threads/send';
export const REVIEW_THREADS_RESOLVE_URL = '/api/threads/resolve';

/** What a send did: its id and round when it went, or why it did not. */
export interface ReviewLoopSendResult {
  ok: boolean;
  /** What went (when `ok`). */
  send?: { id: string; round: number; mode: 'now' | 'round' };
  /** Why it did not (when not `ok`). */
  error?: string;
}

export interface ReviewLoopSendInput {
  mode: 'now' | 'round';
  comments: ReviewLoopCommentInput[];
  /** The person's words before the comments (feedback the journal has no record for). */
  words?: string;
  /** A retry of a press: the key the first try used. */
  key?: string;
}

interface TabMemory {
  seen: string[];
  offsets: Record<string, number>;
  keys: Record<string, string>;
}

const MEMORY_PREFIX = 'plannotator-review-loop:';

function readMemory(review: string): TabMemory {
  try {
    const raw = sessionStorage.getItem(`${MEMORY_PREFIX}${review}`);
    const value = raw ? (JSON.parse(raw) as Partial<TabMemory>) : {};
    return {
      seen: Array.isArray(value.seen) ? value.seen.filter((id): id is string => typeof id === 'string') : [],
      offsets: value.offsets && typeof value.offsets === 'object' ? value.offsets : {},
      keys: value.keys && typeof value.keys === 'object' ? value.keys : {},
    };
  } catch {
    return { seen: [], offsets: {}, keys: {} };
  }
}

function writeMemory(review: string, memory: TabMemory): void {
  try {
    sessionStorage.setItem(`${MEMORY_PREFIX}${review}`, JSON.stringify(memory));
  } catch {
    // A tab without storage keeps it in memory only.
  }
}

function pressKey(): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `page-${id}`;
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON: the status says it.
  }
  return `The server answered ${response.status}.`;
}

export interface ReviewLoop {
  /** The loop was available in this tab: rounds here, and its view (the last one the page read). */
  available: boolean;
  /** The host carries sends now; false while it is away (a send is refused, said so). */
  connected: boolean;
  state: ReviewLoopState | null;
  index: ReviewLoopIndex;
  /** A body of the loop (the event, a write's answer): the state now. */
  receive: (value: unknown) => void;
  send: (input: ReviewLoopSendInput) => Promise<ReviewLoopSendResult>;
  /** Hands a send the host could not deliver over again (its press's key); false when the page does not know its key. */
  retry: (sendId: string) => Promise<ReviewLoopSendResult | null>;
  canRetry: (sendId: string) => boolean;
  resolve: (id: string, resolved: boolean) => Promise<{ ok: boolean; error?: string }>;
  /** The agent's replies the person has not looked at. */
  isNew: (replyId: string) => boolean;
  markSeen: (replyIds: readonly string[]) => void;
  offsets: ReadonlyMap<string, number>;
  rememberOffset: (id: string, offset: number) => void;
}

export function useReviewLoop(options: { enabled: boolean }): ReviewLoop {
  const { enabled } = options;
  const [state, setState] = useState<ReviewLoopState | null>(null);
  const [memory, setMemory] = useState<TabMemory>({ seen: [], offsets: {}, keys: {} });
  const review = state?.review ?? null;
  const reviewRef = useRef(review);
  reviewRef.current = review;

  // Once the loop was available here, its last view stays: a host that went
  // away for a moment (or for good) leaves the sent comments sent, and a write
  // meanwhile is refused by the server, said so, the drafts kept.
  const [connected, setConnected] = useState(false);
  const receive = useCallback((value: unknown) => {
    if (!value || typeof value !== 'object' || typeof (value as { available?: unknown }).available !== 'boolean') return;
    const next = readReviewLoopState(value);
    setConnected(next !== null);
    if (next) setState(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(REVIEW_THREADS_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!cancelled) receive(body);
      })
      .catch(() => {
        // No loop route (a static page, an older server): today's page.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, receive]);

  // The tab's memory of this review, read when the review is known.
  useEffect(() => {
    if (review) setMemory(readMemory(review));
  }, [review]);

  const update = useCallback((change: (current: TabMemory) => TabMemory) => {
    setMemory((current) => {
      const next = change(current);
      if (reviewRef.current) writeMemory(reviewRef.current, next);
      return next;
    });
  }, []);

  const index = useMemo(() => (state ? indexReviewLoop(state.view) : EMPTY_REVIEW_LOOP_INDEX), [state]);
  const seen = useMemo(() => new Set(memory.seen), [memory.seen]);
  const offsets = useMemo(() => new Map(Object.entries(memory.offsets).filter((entry): entry is [string, number] => typeof entry[1] === 'number')), [memory.offsets]);

  const post = useCallback(async (input: ReviewLoopSendInput & { key: string }): Promise<ReviewLoopSendResult> => {
    let response: Response;
    try {
      response = await fetch(REVIEW_THREADS_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: input.mode,
          comments: input.comments,
          ...(input.words ? { words: input.words } : {}),
          idempotency_key: input.key,
        }),
      });
    } catch {
      return { ok: false, error: 'Plannotator could not reach its server.' };
    }
    if (!response.ok) return { ok: false, error: await errorOf(response) };
    const body = (await response.json().catch(() => null)) as { send?: { id?: unknown; round?: unknown; mode?: unknown } } | null;
    receive(body);
    const send = body?.send;
    if (!send || typeof send.id !== 'string') return { ok: false, error: 'The server did not say what it sent.' };
    const sendId = send.id;
    update((current) => ({ ...current, keys: { ...current.keys, [sendId]: input.key } }));
    return { ok: true, send: { id: sendId, round: typeof send.round === 'number' ? send.round : 0, mode: send.mode === 'now' ? 'now' : 'round' } };
  }, [receive, update]);

  const send = useCallback((input: ReviewLoopSendInput) => post({ ...input, key: input.key ?? pressKey() }), [post]);

  const keysRef = useRef(memory.keys);
  keysRef.current = memory.keys;
  const canRetry = useCallback((sendId: string) => typeof keysRef.current[sendId] === 'string', []);
  const retry = useCallback(async (sendId: string) => {
    const key = keysRef.current[sendId];
    if (typeof key !== 'string') return null;
    // The server finds the press by its key and hands its send over again; the body's comments are not read.
    return post({ mode: 'round', comments: [], key });
  }, [post]);

  const resolve = useCallback(async (id: string, resolved: boolean): Promise<{ ok: boolean; error?: string }> => {
    let response: Response;
    try {
      response = await fetch(REVIEW_THREADS_RESOLVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, resolved }),
      });
    } catch {
      return { ok: false, error: 'Plannotator could not reach its server.' };
    }
    if (!response.ok) return { ok: false, error: await errorOf(response) };
    receive(await response.json().catch(() => null));
    return { ok: true };
  }, [receive]);

  const isNew = useCallback((replyId: string) => !seen.has(replyId), [seen]);
  const markSeen = useCallback((replyIds: readonly string[]) => {
    const fresh = replyIds.filter((id) => !seen.has(id));
    if (fresh.length === 0) return;
    update((current) => ({ ...current, seen: [...current.seen, ...fresh].slice(-2000) }));
  }, [seen, update]);
  const rememberOffset = useCallback((id: string, offset: number) => {
    update((current) => ({ ...current, offsets: { ...current.offsets, [id]: offset } }));
  }, [update]);

  return {
    available: enabled && state !== null,
    connected: enabled && state !== null && connected,
    state,
    index,
    receive,
    send,
    retry,
    canRetry,
    resolve,
    isNew,
    markSeen,
    offsets,
    rememberOffset,
  };
}
