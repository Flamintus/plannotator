/**
 * The thread kept for the conversation (experimental "persistent-comments";
 * the rules in roundLines.ts): a Send whose comments live in their boxes is
 * one line in place of the message, the end of a round, which a press opens
 * to the text the agent got (`RoundRow`, `onToggle`); an agent's message that
 * only replied under comments is one line too, with nothing to open. A Send
 * with the person's words keeps its message, and the sections the boxes
 * hold fold into one line under the words (`RoundFold`).
 *
 * `RoundRow` is laid out as a folded message's line (`ib-fline`: mark, who,
 * words, time), so the thread reads the same folded or not; it is not a fold
 * of the message, so the thread's folding, "N earlier messages" and the
 * messages kept open for their threads work around it unchanged.
 */
import { useId, useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { Tip } from './Tip';

export function RoundRow({
  mark,
  who,
  words,
  time,
  fullWhen,
  isNew,
  open,
  onToggle,
  controls,
}: {
  mark: ReactNode;
  who: string;
  words: string;
  time: string;
  fullWhen: string;
  isNew: boolean;
  /** The text the agent got is shown under the line. */
  open?: boolean;
  /** A press opens or closes it. Absent: a line with nothing to open (an agent's replies). */
  onToggle?: () => void;
  /** The id of what the press opens. */
  controls?: string;
}) {
  const parts = (
    <>
      <span className="ib-a11y-skip" aria-hidden={onToggle ? true : undefined}>
        {mark}
      </span>
      <span className="ib-fl-nm" aria-hidden={onToggle ? true : undefined}>
        <bdi>{who}</bdi>
      </span>
      <Tip content={words} cut>
        <span className="ib-fl-sn" dir="auto" data-round-words="" aria-hidden={onToggle ? true : undefined}>
          {words}
        </span>
      </Tip>
      <span className="ib-fl-chips" />
      <span className="ib-fl-tm" aria-hidden={onToggle ? true : undefined}>
        {isNew && <span className="ib-newtag">New</span>}
        <Tip content={fullWhen}>
          <span data-full-when="">{time}</span>
        </Tip>
        {onToggle && <Icon name={open ? 'chevD' : 'chevR'} size={14} />}
      </span>
    </>
  );
  if (!onToggle) {
    return (
      <div className="ib-fline ib-roundl" data-round-row="">
        {parts}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ib-fline ib-roundl"
      data-round-row=""
      data-fold-head=""
      aria-expanded={open === true}
      aria-controls={open ? controls : undefined}
      aria-label={`${who}, ${time}${isNew ? ', new' : ''}. ${words}. ${open ? 'Hide' : 'Show'} what was sent`}
      onClick={onToggle}
    >
      {parts}
    </button>
  );
}

/** Under the person's words: the sections the boxes hold, folded into one line; a press shows them as sent (`children`). */
export function RoundFold({ words, children }: { words: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="ib-roundf" data-round-fold="" data-open={open ? '' : undefined}>
      <button type="button" className="ib-roundf-b" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((shown) => !shown)}>
        <Icon name="comment" size={14} />
        <span className="ib-roundf-t" data-round-words="">
          {words}
        </span>
        <Icon name={open ? 'chevD' : 'chevR'} size={12} />
      </button>
      {open && (
        <div id={id} className="ib-roundf-text">
          {children}
        </div>
      )}
    </div>
  );
}
