import { sliceText } from '@plannotator/core/inbox-questions';

/** A quote as a sheet's title or a comment card names it: one line, cut at a word. */
export function shortLabel(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : sliceText(line, 60)}…`;
}
