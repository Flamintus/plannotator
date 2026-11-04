import { AnnotationType, type Annotation } from '@plannotator/ui/types';

/**
 * The page a live app session stamps on an annotation as it is added:
 * restore filters by page and the export groups by page. `livePageUrl` is
 * the page open now ('' before the app reports one: nothing is stamped).
 *
 * A global comment has no page location and stays unstamped. A reply keeps
 * its parent's page, a person's Reply and an agent's `add_comments
 * { inReplyTo }` alike: it carries the parent's anchor, and the panel lists
 * every page's comments, so the page open when it is written can be another.
 */
export function stampLivePage(annotation: Annotation, livePageUrl: string): Annotation {
  if (!livePageUrl || annotation.type === AnnotationType.GLOBAL_COMMENT || annotation.inReplyTo) return annotation;
  return { ...annotation, pageUrl: livePageUrl };
}
