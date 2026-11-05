/**
 * The selection toolbar over a passage of a message's words (a sub-thread's
 * offer, utils/passageSelection.ts): the package's own `AnnotationToolbar`,
 * with the options the document's selection toolbar has on the same surface
 * (`options`, as the host passes them to its `Viewer`), so a passage offers
 * what the document's words offer and reads the keys the same way: Delete,
 * Comment, the quick labels and 👍 Looks good, Copy, a letter typed starts
 * the comment, Escape closes it. Comment opens the host's box; Delete and a
 * label make their comment at once (`onPreset`), as on the document. It
 * stands over where the selection was, and a scroll or a resize closes it,
 * as crit's selection toolbar does: it never moves away from the words.
 */
import React, { useCallback, useEffect, useState } from 'react';
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

export const PassageToolbar: React.FC<{
  passage: SelectedPassage;
  options?: PassageToolbarOptions;
  /** Comment pressed, or a letter typed (`initialChar`). */
  onComment: (initialChar?: string) => void;
  /** Delete or a quick label: its comment, made at once. Absent: Comment only. */
  onPreset?: (comment: PassageComment) => void;
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
          commentOnly={options?.commentOnly === true || !onPreset}
          quickLabels={options?.quickLabels}
          copyText={passage.quote}
          onAnnotate={(type) => (type === AnnotationType.DELETION && onPreset ? onPreset(DELETION_COMMENT) : onComment())}
          onRequestComment={onComment}
          onQuickLabel={onPreset ? (label) => onPreset(quickLabelComment(label)) : undefined}
          onClose={onClose}
        />
      )}
    </>
  );
};
