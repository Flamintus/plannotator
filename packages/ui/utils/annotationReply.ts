import { AnnotationType, type Annotation } from '../types';

/** What the author of a reply brings; everything else comes from the parent. */
export interface ReplyFields {
  id: string;
  text: string;
  createdA: number;
  author?: string;
  source?: string;
  mentions?: readonly string[];
}

/**
 * The annotation that replies to `parent` (`inReplyTo`), for every author: a
 * person's Reply in the annotations panel and a browser agent's
 * `add_comments { inReplyTo }` build it here, so the two cannot drift.
 *
 * A reply takes its parent's place: the same block, offsets and quote, and
 * the anchors that locate them (text metas, a raw-HTML element, a diagram
 * part, a live-app page, the plan diff). It threads under the parent in the
 * panel and the export, and if the parent is removed it stays a comment on
 * the same place. A reply to a deletion is a comment: it says something about
 * the deleted text, it does not delete it again. Pure.
 */
export function buildReplyAnnotation(parent: Annotation, reply: ReplyFields): Annotation {
  return {
    id: reply.id,
    blockId: parent.blockId,
    startOffset: parent.startOffset,
    endOffset: parent.endOffset,
    type: parent.type === AnnotationType.DELETION ? AnnotationType.COMMENT : parent.type,
    text: reply.text,
    originalText: parent.originalText,
    createdA: reply.createdA,
    ...(reply.author ? { author: reply.author } : {}),
    ...(reply.source ? { source: reply.source } : {}),
    ...(reply.mentions && reply.mentions.length > 0 ? { mentions: reply.mentions } : {}),
    inReplyTo: parent.id,
    ...(parent.startMeta ? { startMeta: parent.startMeta } : {}),
    ...(parent.endMeta ? { endMeta: parent.endMeta } : {}),
    ...(parent.htmlAnchor ? { htmlAnchor: parent.htmlAnchor } : {}),
    // A reply to a diagram comment is a diagram comment: without the anchor
    // it would fall to text search and paint the node's label wherever the
    // prose repeats it.
    ...(parent.diagramAnchor ? { diagramAnchor: parent.diagramAnchor } : {}),
    ...(parent.pageUrl ? { pageUrl: parent.pageUrl } : {}),
    ...(parent.diffContext ? { diffContext: parent.diffContext } : {}),
  };
}
