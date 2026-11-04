/**
 * Comments that stay after Send (experimental "persistent-comments"), as the
 * window draws them: the thread's part (`useSentComments`), the file pane's
 * part (`useSentFileComments`) and the list under an agent's message
 * (`SentComments`). The rules are in sentComments.ts and
 * packages/core/inbox-comment-threads.ts. With the switch off the thread's
 * files carry no `sent_comments`, and every part here is a no-op.
 *
 * The person resolves a sent comment, or opens it again, from its card in the
 * file's panel or its row under the message (not on a linked machine's
 * thread: the device door does not forward it). A resolved comment leaves
 * the highlights and folds: its card keeps its header (its round, Resolved)
 * and Reopen, and under the message it waits behind "N resolved".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inboxCommentRounds, inboxCommentState, type InboxCommentRoundMessage } from '@plannotator/core/inbox-comment-threads';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { InboxApiError, inboxApi, type AttachmentsModel } from '../api';
import { annotationOf, annotationQuote, isFileComment, shortLabel } from '../attachments';
import { followCodeLines, sentUnanchoredChanges, withSentWrites } from '../sentComments';

const NO_RECORDS: readonly InboxAnnotationRecord[] = [];
const NO_WRITES: ReadonlyMap<string, InboxAnnotationRecord> = new Map();

type UnanchoredReport = { attempted: readonly string[]; unanchored: readonly string[] };

/** The person resolved it (a reply under it would open it again: inboxCommentState). */
const isResolved = (record: InboxAnnotationRecord) => inboxCommentState(record) === 'resolved';

/** What the file pane gets of a thread's sent comments. */
export interface SentFileComments {
  /** The thread's file comments a Send carried. */
  records: readonly InboxAnnotationRecord[];
  /** Each reply that carried comments, by id, with its round. */
  rounds: ReadonlyMap<string, number>;
  /** What the pane found of their words. */
  onUnanchoredReport: (report: UnanchoredReport) => void;
  /** The person resolves one, or opens it again (absent: no Resolve, a linked machine's thread). */
  onResolve?: (record: InboxAnnotationRecord, resolved: boolean) => void;
}

/**
 * The thread's sent comments, from its files (`sent_comments`, present only
 * while the switch is on): their rounds, the open ones (`open`: highlighted
 * in their message), all of them by message, the pane's part (`pane`),
 * `report`, which keeps what the window found of their words (the store's
 * event then reads the files again), and `resolve`, the person's Resolve or
 * Reopen (drawn as soon as the Inbox answers; a refusal goes to `onError`),
 * absent when `canResolve` is false.
 */
export function useSentComments(messages: readonly InboxCommentRoundMessage[], files: AttachmentsModel | null, onError: (message: string) => void, canResolve: boolean) {
  const listed = files?.sent_comments ?? NO_RECORDS;
  const [written, setWritten] = useState(NO_WRITES);
  const records = useMemo(() => withSentWrites(listed, written), [listed, written]);
  const rounds = useMemo(() => inboxCommentRounds(messages, records), [messages, records]);
  const open = useMemo(() => records.filter((record) => !isResolved(record)), [records]);
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
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const resolve = useCallback((record: InboxAnnotationRecord, resolved: boolean) => {
    void inboxApi.resolveComment(record.id, resolved).then(
      ({ annotation }) => setWritten((current) => new Map(current).set(annotation.id, annotation)),
      (cause: unknown) => onErrorRef.current(cause instanceof InboxApiError ? cause.message : 'The comment did not change.'),
    );
  }, []);
  const fileRecords = useMemo(() => records.filter(isFileComment), [records]);
  const pane = useMemo<SentFileComments | undefined>(
    () => (files?.sent_comments ? { records: fileRecords, rounds, onUnanchoredReport: report, ...(canResolve ? { onResolve: resolve } : {}) } : undefined),
    [files?.sent_comments, fileRecords, rounds, report, resolve, canResolve],
  );
  return { records, open, rounds, byMessage, report, resolve: canResolve ? resolve : undefined, pane };
}

/**
 * The file pane's part: its records are the drafts plus this file's sent
 * comments; a sent code comment follows its lines on the file shown; a sent
 * card has its round, no edit or delete, and Resolve (Reopen once resolved,
 * when the card folds to its header); a resolved comment is not painted on
 * the file (`annotations`) but stays in the panel (`panelAnnotations`), and
 * one opened again is painted again (`repaint`); and what the pane finds of
 * their words is reported once per comment and file read (`view.key`), so a
 * reload of the records never sends it again.
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
  /** No Resolve or Reopen (the pane takes no comments). */
  readOnly: boolean;
  /** Paint comments on the file shown (the viewer's `applySharedAnnotations`; it skips one already painted). */
  repaint: (annotations: Annotation[]) => void;
}) {
  const { sent, drafts, path, version, isCode, view, setUnanchored, readOnly, repaint } = input;
  const sentRecords = sent?.records;
  const fileRecords = useMemo(
    () => [...drafts, ...(sentRecords ?? NO_RECORDS)].filter((r) => r.path === path && r.version === version),
    [drafts, sentRecords, path, version],
  );
  const sentById = useMemo(() => new Map((sentRecords ?? NO_RECORDS).map((r) => [r.id, r])), [sentRecords]);
  const sentIds = useMemo(() => new Set(sentById.keys()), [sentById]);
  const resolvedIds = useMemo(() => new Set((sentRecords ?? NO_RECORDS).filter(isResolved).map((r) => r.id)), [sentRecords]);
  /** This file's sent comments (the panel's "All files" groups list them with its drafts). */
  const sentHere = useMemo(() => fileRecords.filter((r) => sentIds.has(r.id)), [fileRecords, sentIds]);
  const text = view?.text;
  const codeLines = useMemo(() => (isCode && text !== undefined && sentIds.size > 0 ? text.split('\n') : null), [isCode, text, sentIds]);
  const panelAnnotations = useMemo(
    () => fileRecords.map((r) => (codeLines && sentIds.has(r.id) ? followCodeLines(annotationOf(r), codeLines) : annotationOf(r))),
    [fileRecords, codeLines, sentIds],
  );
  // What the file paints and counts: a resolved comment leaves its words.
  const annotations = useMemo(() => (resolvedIds.size === 0 ? panelAnnotations : panelAnnotations.filter((a) => !resolvedIds.has(a.id))), [panelAnnotations, resolvedIds]);
  // The image and video views draw their own remove controls: a sent comment is in the panel only.
  const ownAnnotations = useMemo(() => (sentIds.size === 0 ? annotations : annotations.filter((a) => !sentIds.has(a.id))), [annotations, sentIds]);
  // A comment opened again is painted again, once the viewer has it (a resolved one left the page with `annotations`).
  const latestAnnotations = useRef(annotations);
  latestAnnotations.current = annotations;
  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;
  const wasResolved = useRef(resolvedIds);
  useEffect(() => {
    const before = wasResolved.current;
    wasResolved.current = resolvedIds;
    const reopened = new Set([...before].filter((id) => !resolvedIds.has(id)));
    if (reopened.size === 0) return;
    requestAnimationFrame(() => {
      const list = latestAnnotations.current.filter((a) => reopened.has(a.id));
      if (list.length > 0) repaintRef.current(list);
    });
  }, [resolvedIds]);
  const rounds = useMemo(() => {
    const out = new Map<string, number>();
    for (const record of sentRecords ?? NO_RECORDS) {
      const round = record.sent_reply_id ? sent?.rounds.get(record.sent_reply_id) : undefined;
      if (round !== undefined) out.set(record.id, round);
    }
    return out;
  }, [sentRecords, sent?.rounds]);

  /** A sent card: its round (and Resolved) after the card's own header. */
  const withSentRound = (header: ((annotation: Annotation) => ReactNode) | undefined) =>
    sentIds.size === 0
      ? header
      : (annotation: Annotation) => {
          const own = header?.(annotation) ?? null;
          const round = rounds.get(annotation.id);
          if (round === undefined) return own;
          return (
            <>
              {own}
              <span className="ib-sentc-chip" data-sent-round={round}>
                Round {round}
              </span>
              {resolvedIds.has(annotation.id) && (
                <span className="ib-sentc-chip" data-sent-resolved="">
                  Resolved
                </span>
              )}
            </>
          );
        };
  /** A sent card: no edit or delete; resolved, folded to its header. */
  const withSentParts =
    <T extends object>(parts: (annotation: Annotation) => T) =>
    (annotation: Annotation) => {
      if (!sentIds.has(annotation.id)) return parts(annotation);
      return resolvedIds.has(annotation.id) ? { ...parts(annotation), actions: false, quote: false, text: false, images: false } : { ...parts(annotation), actions: false };
    };
  /** A resolved card draws no body of its own either (a drawing's picture). */
  const withSentBody = (body: (annotation: Annotation) => ReactNode) => (annotation: Annotation) => (resolvedIds.has(annotation.id) ? null : body(annotation));
  /** A sent card's foot: Resolve, or Reopen once resolved. */
  const onResolve = sent?.onResolve;
  const sentFooter =
    sentIds.size === 0 || readOnly || !onResolve
      ? undefined
      : (annotation: Annotation) => {
          const record = sentById.get(annotation.id);
          if (!record) return null;
          const resolved = resolvedIds.has(record.id);
          return (
            <button type="button" className="ib-sentc-act" data-sent-resolve={record.id} onClick={() => onResolve(record, !resolved)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
          );
        };

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

  return { sentHere, sentIds, annotations, panelAnnotations, ownAnnotations, withSentRound, withSentParts, withSentBody, sentFooter, reportUnanchored };
}

/**
 * The comments the person sent on an agent's message, under it, each with its
 * round. The open ones' passages stay highlighted in the message; a row
 * brings its passage into view. Each has Resolve (`onResolve`; absent: none);
 * the resolved ones wait behind "N resolved", each with Reopen.
 */
export function SentComments({
  records,
  rounds,
  onOpen,
  onResolve,
}: {
  records: readonly InboxAnnotationRecord[];
  rounds: ReadonlyMap<string, number>;
  onOpen: (record: InboxAnnotationRecord) => void;
  onResolve?: (record: InboxAnnotationRecord, resolved: boolean) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  if (records.length === 0) return null;
  const open = records.filter((record) => !isResolved(record));
  const resolved = records.filter(isResolved);
  const row = (record: InboxAnnotationRecord, isResolvedRow: boolean) => {
    const annotation = annotationOf(record);
    const round = record.sent_reply_id ? rounds.get(record.sent_reply_id) : undefined;
    return (
      <li key={record.id} className="ib-sentc-item" data-sent-comment={record.id} data-sent-resolved={isResolvedRow ? '' : undefined}>
        <button type="button" className="ib-sentc-row" onClick={() => onOpen(record)}>
          {round !== undefined && <span className="ib-sentc-chip" data-sent-round={round}>Round {round}</span>}
          {typeof record.unanchored_at === 'string' && <span className="ib-sentc-chip" data-sent-unanchored="">Unanchored</span>}
          <span className="ib-sentc-quote">“{shortLabel(annotationQuote(annotation))}”</span>
          <span className="ib-sentc-text">{annotation.text}</span>
        </button>
        {onResolve && (
          <button type="button" className="ib-sentc-act" data-sent-resolve={record.id} onClick={() => onResolve(record, !isResolvedRow)}>
            {isResolvedRow ? 'Reopen' : 'Resolve'}
          </button>
        )}
      </li>
    );
  };
  return (
    <ul className="ib-sentc" data-sent-comments="" aria-label="Comments you sent">
      {open.map((record) => row(record, false))}
      {resolved.length > 0 && (
        <li>
          <button type="button" className="ib-sentc-more" aria-expanded={showResolved} data-sent-resolved-toggle="" onClick={() => setShowResolved((shown) => !shown)}>
            {resolved.length} resolved
          </button>
        </li>
      )}
      {showResolved && resolved.map((record) => row(record, true))}
    </ul>
  );
}
