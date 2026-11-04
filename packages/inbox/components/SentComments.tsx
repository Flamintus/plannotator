/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the thread's part (`useSentComments`), the file pane's
 * part (`useSentFileComments`) and the list under an agent's message
 * (`SentComments`). The rules are in sentComments.ts and
 * packages/core/inbox-comment-threads.ts. With the switch off the thread's
 * files carry no `sent_comments`, and every part here is a no-op.
 */
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { inboxCommentRounds, type InboxCommentRoundMessage } from '@plannotator/core/inbox-comment-threads';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, annotationQuote, isFileComment, shortLabel } from '../attachments';
import { followCodeLines, sentUnanchoredChanges } from '../sentComments';

const NO_RECORDS: readonly InboxAnnotationRecord[] = [];

type UnanchoredReport = { attempted: readonly string[]; unanchored: readonly string[] };

/** What the file pane gets of a thread's sent comments. */
export interface SentFileComments {
  /** The thread's file comments a Send carried. */
  records: readonly InboxAnnotationRecord[];
  /** Each reply that carried comments, by id, with its round. */
  rounds: ReadonlyMap<string, number>;
  /** What the pane found of their words. */
  onUnanchoredReport: (report: UnanchoredReport) => void;
}

/**
 * The thread's sent comments, from its files (`sent_comments`, present only
 * while the switch is on): their rounds, the message ones by message, the
 * pane's part (`pane`), and `report`, which keeps what the window found of
 * their words (the store's event then reads the files again).
 */
export function useSentComments(messages: readonly InboxCommentRoundMessage[], files: AttachmentsModel | null) {
  const records = files?.sent_comments ?? NO_RECORDS;
  const rounds = useMemo(() => inboxCommentRounds(messages, records), [messages, records]);
  const byMessage = useMemo(() => {
    const out = new Map<string, InboxAnnotationRecord[]>();
    for (const record of records) if (record.message) out.set(record.message_id, [...(out.get(record.message_id) ?? []), record]);
    return out;
  }, [records]);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const report = useCallback((found: UnanchoredReport) => {
    for (const change of sentUnanchoredChanges(recordsRef.current, found)) void inboxApi.markUnanchored(change.id, change.unanchored).catch(() => {});
  }, []);
  const fileRecords = useMemo(() => records.filter(isFileComment), [records]);
  const pane = useMemo<SentFileComments | undefined>(
    () => (files?.sent_comments ? { records: fileRecords, rounds, onUnanchoredReport: report } : undefined),
    [files?.sent_comments, fileRecords, rounds, report],
  );
  return { records, rounds, byMessage, report, pane };
}

/**
 * The file pane's part: its records are the drafts plus this file's sent
 * comments; a sent code comment follows its lines on the file shown; a sent
 * card has its round and no edit or delete; and what the pane finds of their
 * words is reported once per comment and file read (`view.key`), so a reload
 * of the records never sends it again.
 */
export function useSentFileComments(input: {
  sent: SentFileComments | undefined;
  drafts: readonly InboxAnnotationRecord[];
  path: string;
  version: string;
  isCode: boolean;
  /** The file's text as shown, and a key that changes with each read of it. */
  view: { text: string; key: string } | null;
  setUnanchored: (ids: ReadonlySet<string>) => void;
}) {
  const { sent, drafts, path, version, isCode, view, setUnanchored } = input;
  const sentRecords = sent?.records;
  const fileRecords = useMemo(
    () => [...drafts, ...(sentRecords ?? NO_RECORDS)].filter((r) => r.path === path && r.version === version),
    [drafts, sentRecords, path, version],
  );
  const sentIds = useMemo(() => new Set((sentRecords ?? NO_RECORDS).map((r) => r.id)), [sentRecords]);
  /** This file's sent comments (the panel's "All files" groups list them with its drafts). */
  const sentHere = useMemo(() => fileRecords.filter((r) => sentIds.has(r.id)), [fileRecords, sentIds]);
  const text = view?.text;
  const codeLines = useMemo(() => (isCode && text !== undefined && sentIds.size > 0 ? text.split('\n') : null), [isCode, text, sentIds]);
  const annotations = useMemo(
    () => fileRecords.map((r) => (codeLines && sentIds.has(r.id) ? followCodeLines(annotationOf(r), codeLines) : annotationOf(r))),
    [fileRecords, codeLines, sentIds],
  );
  // The image and video views draw their own remove controls: a sent comment is in the panel only.
  const ownAnnotations = useMemo(() => (sentIds.size === 0 ? annotations : annotations.filter((a) => !sentIds.has(a.id))), [annotations, sentIds]);
  const rounds = useMemo(() => {
    const out = new Map<string, number>();
    for (const record of sentRecords ?? NO_RECORDS) {
      const round = record.sent_reply_id ? sent?.rounds.get(record.sent_reply_id) : undefined;
      if (round !== undefined) out.set(record.id, round);
    }
    return out;
  }, [sentRecords, sent?.rounds]);

  /** A sent card: its round after the card's own header. */
  const withSentRound = (header: ((annotation: Annotation) => ReactNode) | undefined) =>
    sentIds.size === 0
      ? header
      : (annotation: Annotation) => {
          const own = header?.(annotation) ?? null;
          const round = rounds.get(annotation.id);
          return round === undefined ? own : (
            <>
              {own}
              <span className="ib-sentc-chip" data-sent-round={round}>
                Round {round}
              </span>
            </>
          );
        };
  /** A sent card: no edit or delete. */
  const withSentParts =
    <T extends object>(parts: (annotation: Annotation) => T) =>
    (annotation: Annotation) =>
      sentIds.has(annotation.id) ? { ...parts(annotation), actions: false } : parts(annotation);

  const latest = useRef({ sent, sentIds, viewKey: view?.key ?? '' });
  latest.current = { sent, sentIds, viewKey: view?.key ?? '' };
  const reported = useRef<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() });
  /** What the pane found of the comments' words: shown as Unanchored, and kept for a sent comment, once per file read. */
  const reportUnanchored = useCallback(
    (attempted: readonly string[], ids: Iterable<string>) => {
      const lost = new Set(ids);
      setUnanchored(lost);
      const { sent: now, sentIds: ofSent, viewKey } = latest.current;
      if (!now) return;
      if (reported.current.key !== viewKey) reported.current = { key: viewKey, ids: new Set() };
      const fresh = attempted.filter((id) => ofSent.has(id) && !reported.current.ids.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) reported.current.ids.add(id);
      now.onUnanchoredReport({ attempted: fresh, unanchored: fresh.filter((id) => lost.has(id)) });
    },
    [setUnanchored],
  );

  return { sentHere, sentIds, annotations, ownAnnotations, withSentRound, withSentParts, reportUnanchored };
}

/**
 * The comments the person sent on an agent's message, under it, each with its
 * round. Their passages stay highlighted in the message; a row brings its
 * passage into view.
 */
export function SentComments({
  records,
  rounds,
  onOpen,
}: {
  records: readonly InboxAnnotationRecord[];
  rounds: ReadonlyMap<string, number>;
  onOpen: (record: InboxAnnotationRecord) => void;
}) {
  if (records.length === 0) return null;
  return (
    <ul className="ib-sentc" data-sent-comments="" aria-label="Comments you sent">
      {records.map((record) => {
        const annotation = annotationOf(record);
        const round = record.sent_reply_id ? rounds.get(record.sent_reply_id) : undefined;
        return (
          <li key={record.id}>
            <button type="button" className="ib-sentc-row" data-sent-comment={record.id} onClick={() => onOpen(record)}>
              {round !== undefined && <span className="ib-sentc-chip" data-sent-round={round}>Round {round}</span>}
              {typeof record.unanchored_at === 'string' && <span className="ib-sentc-chip" data-sent-unanchored="">Unanchored</span>}
              <span className="ib-sentc-quote">“{shortLabel(annotationQuote(annotation))}”</span>
              <span className="ib-sentc-text">{annotation.text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
