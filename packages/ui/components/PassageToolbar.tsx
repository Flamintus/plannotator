/**
 * The selection toolbar over a passage of a message's words (a sub-thread's
 * offer, utils/passageSelection.ts): the package's own `AnnotationToolbar`,
 * comment-only, so it reads and answers the keys as it does over a document
 * (Comment, Copy, a letter typed starts the comment, Escape closes it). It
 * stands over where the selection was, and a scroll or a resize closes it,
 * as crit's selection toolbar does: it never moves away from the words.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnnotationToolbar } from './AnnotationToolbar';
import type { SelectedPassage } from '../utils/passageSelection';

export const PassageToolbar: React.FC<{
  passage: SelectedPassage;
  /** Comment pressed, or a letter typed (`initialChar`). */
  onComment: (initialChar?: string) => void;
  onClose: () => void;
}> = ({ passage, onComment, onClose }) => {
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
          commentOnly
          copyText={passage.quote}
          onAnnotate={() => onComment()}
          onRequestComment={onComment}
          onClose={onClose}
        />
      )}
    </>
  );
};
