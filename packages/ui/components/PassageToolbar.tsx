/**
 * The one way a comment is made on a passage of a message's words (a
 * sub-thread's offer, utils/passageSelection.ts), wherever messages' words are
 * drawn: a box in the text (inbox-thread/SentThreads.tsx) or a card of the
 * comments panel (AnnotationPanel.tsx). `usePassageOffer` turns a selection
 * let go into an offer; `PassageToolbar` is the package's own
 * `AnnotationToolbar` over it, with the options the document's selection
 * toolbar has on the same surface (`options`, as the host passes them to its
 * `Viewer`), so a passage offers what the document's words offer and reads
 * the keys the same way: Delete, Comment, the quick labels and 👍 Looks good,
 * Copy, a letter typed starts the comment, Escape closes it. Each action
 * closes the offer and lets the selection go before it calls the host:
 * Comment opens the host's box on the passage; Delete and a label make their
 * comment at once (`onPreset`, `PassageComment`), as on the document. It
 * stands over where the selection was, and a scroll or a resize closes it, as
 * crit's selection toolbar does: it never moves away from the words.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnnotationType } from '../types';
import { AnnotationToolbar } from './AnnotationToolbar';
import { DELETION_COMMENT, quickLabelComment, type PassageComment, type SelectedPassage } from '../utils/passageSelection';

/** The options of the document's own selection toolbar on a surface (`Viewer`'s), which a passage's toolbar there takes too. */
export interface PassageToolbarOptions {
  /** Comment-only surface (an answer-only message, an HTML page): no Delete, no labels' picker; 👍 stays. */
  commentOnly?: boolean;
  /** `false`: no labels' picker and no Alt+digit labels; 👍 stays. */
  quickLabels?: boolean;
}

/**
 * What a selection let go offers for a comment while `enabled`: `read` turns the document's selection into an offer
 * (null: none here). It listens on the document, since a drag past a body's last line ends outside it.
 */
export function usePassageOffer<T>(enabled: boolean, read: (selection: Selection | null) => T | null): { offer: T | null; close: () => void } {
  const [offer, setOffer] = useState<T | null>(null);
  const reader = useRef(read);
  reader.current = read;
  const close = useCallback(() => setOffer(null), []);
  useEffect(() => {
    if (!enabled) return;
    const offerPassage = () => setOffer(reader.current(document.getSelection()));
    document.addEventListener('mouseup', offerPassage);
    return () => document.removeEventListener('mouseup', offerPassage);
  }, [enabled]);
  return { offer, close };
}

export const PassageToolbar: React.FC<{
  passage: SelectedPassage;
  options?: PassageToolbarOptions;
  /** Comment pressed, or a letter typed (`initialChar`): the host opens its box on the passage. */
  onComment: (passage: SelectedPassage, initialChar?: string) => void;
  /** Delete or a quick label: its comment on the passage, made at once. Absent: Comment only. */
  onPreset?: (passage: SelectedPassage, comment: PassageComment) => void;
  /** Closes the offer: an action taken, Escape, a scroll or a resize. */
  onClose: () => void;
}> = ({ passage, options, onComment, onPreset, onClose }) => {
  // The toolbar places itself over an element: a still one where the selection was.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const anchorRef = useCallback((node: HTMLSpanElement | null) => setAnchor(node), []);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);
  /** An action taken: the offer closes and the selection goes (the box quotes the words, or the comment is made). */
  const take = (then: () => void) => {
    onClose();
    document.getSelection()?.removeAllRanges();
    then();
  };
  const comment = (initialChar?: string) => take(() => onComment(passage, initialChar));
  const preset = onPreset ? (made: PassageComment) => take(() => onPreset(passage, made)) : undefined;
  const { top, left, width, height } = passage.rect;
  return (
    <>
      {createPortal(
        <span
          ref={anchorRef}
          aria-hidden="true"
          data-passage-toolbar-anchor=""
          style={{ position: 'fixed', top, left, width, height, pointerEvents: 'none', visibility: 'hidden' }}
        />,
        document.body,
      )}
      {anchor && (
        <AnnotationToolbar
          element={anchor}
          positionMode="center-above"
          commentOnly={options?.commentOnly === true || !preset}
          quickLabels={options?.quickLabels}
          copyText={passage.quote}
          onAnnotate={(type) => (type === AnnotationType.DELETION && preset ? preset(DELETION_COMMENT) : comment())}
          onRequestComment={comment}
          onQuickLabel={preset ? (label) => preset(quickLabelComment(label)) : undefined}
          onClose={onClose}
        />
      )}
    </>
  );
};
