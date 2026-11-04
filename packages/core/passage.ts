/**
 * A passage of a message's words, as a reader selected it in the words as
 * drawn: its text (`quote`) and where it starts (`offset`). The offset counts
 * characters of the words with every run of whitespace read as one space and
 * the leading whitespace dropped, as crit's sub-threads do, so the place holds
 * whether the words are drawn wrapped, pre-wrapped or with their newlines.
 *
 * A sub-thread of the Inbox's comment threads is a comment on such a passage
 * (packages/core/inbox-comment-threads.ts): @plannotator/ui marks the passage
 * in its message's words, and an agent reads it with the words around it.
 *
 * Browser-safe and zero-dep.
 */

export interface TextPassage {
  /** The words selected, as drawn. */
  quote: string;
  /** Where they start in the drawn words, whitespace runs counted as one. */
  offset: number;
}

/** `text` with each run of whitespace read as one space, leading whitespace dropped, and each kept character's index in `text`. */
function normalized(text: string): { text: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      space = out !== '';
      continue;
    }
    if (space) {
      out += ' ';
      at.push(i - 1);
      space = false;
    }
    out += ch;
    at.push(i);
  }
  return { text: out, at };
}

/** A quote as a passage compares it: whitespace runs as one space, trimmed. */
export function passageQuote(quote: string): string {
  return quote.replace(/\s+/g, ' ').trim();
}

/** Where the character at `index` of `text` is, as a passage counts it (whitespace runs as one, leading whitespace dropped). */
export function passageOffset(text: string, index: number): number {
  const { at } = normalized(text);
  let offset = 0;
  while (offset < at.length && at[offset]! < index) offset++;
  return offset;
}

/**
 * Where a passage is in `text`: its first and past-the-end indices in `text`,
 * the occurrence of its quote at its offset, else the nearest one, or null
 * when the words no longer hold the quote.
 */
export function findPassage(text: string, passage: TextPassage): [number, number] | null {
  const quote = passageQuote(passage.quote);
  if (quote === '') return null;
  const { text: flat, at } = normalized(text);
  let best = -1;
  for (let from = flat.indexOf(quote); from >= 0; from = flat.indexOf(quote, from + 1)) {
    if (best < 0 || Math.abs(from - passage.offset) < Math.abs(best - passage.offset)) best = from;
    if (from >= passage.offset) break;
  }
  if (best < 0) return null;
  return [at[best]!, at[best + quote.length - 1]! + 1];
}

/**
 * `text` cut to about `max` characters around its passage, with `…` where it
 * was cut, whitespace runs read as one: what an agent reads of the words a
 * passage is in, and where the passage starts in that cut (its offset there).
 * The text from its start when the passage is not found.
 */
export function passageWindow(text: string, passage: TextPassage, max: number): { text: string; offset: number } {
  const flat = passageQuote(text);
  const quote = passageQuote(passage.quote);
  const found = findPassage(flat, { quote, offset: passage.offset });
  const start = found ? found[0] : 0;
  if (flat.length <= max) return { text: flat, offset: start };
  const end = found ? found[1] : 0;
  const room = Math.max(0, max - (end - start));
  let from = Math.max(0, start - Math.floor(room / 2));
  let to = Math.min(flat.length, Math.max(end, from + max));
  from = Math.max(0, Math.min(from, to - max));
  // Never cut a word in two: move each cut to the nearest word boundary that keeps the passage whole.
  if (from > 0 && isWordChar(flat[from - 1]) && isWordChar(flat[from])) {
    const next = flat.indexOf(' ', from);
    from = next !== -1 && next < start ? next + 1 : flat.lastIndexOf(' ', from) + 1;
  }
  if (to < flat.length && isWordChar(flat[to - 1]) && isWordChar(flat[to])) {
    const before = flat.lastIndexOf(' ', to);
    to = before >= end ? before : (flat.indexOf(' ', to) === -1 ? flat.length : flat.indexOf(' ', to));
  }
  const piece = flat.slice(from, to);
  const lead = piece.length - piece.trimStart().length;
  const cut = from > 0 ? '…' : '';
  return { text: `${cut}${piece.trim()}${to < flat.length ? '…' : ''}`, offset: cut.length + Math.max(0, start - from - lead) };
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && char !== ' ';
}

/** `passageWindow`'s words alone. */
export function passageContext(text: string, passage: TextPassage, max: number): string {
  return passageWindow(text, passage, max).text;
}
