import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { annotationOf, annotationQuote, shortLabel } from '../attachments';

/**
 * The comments the person sent on an agent's message, under it, each with its
 * round (experimental "persistent-comments"). Their passages stay highlighted
 * in the message; a row brings its passage into view.
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
