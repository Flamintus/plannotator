/**
 * The screens draw the review loop's comment threads with the Inbox window's
 * boxes (ui `SentThreads`), so their rules are the Inbox's: packages/editor/reviewLoopBoxes.css
 * holds a copy of packages/inbox/inbox.css's block, which stays their one
 * source. This keeps the copy the same, and every box class the component
 * draws styled in both sheets.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const START = '/* Comments that stay after Send (experimental "persistent-comments"; SentComments.tsx)';
const END = '.ib-sentc-acts { display: flex; justify-content: flex-end; gap: 4px; }';

function block(css: string): string {
  const start = css.indexOf(START);
  const end = css.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error('the boxes block is not where it was');
  return css.slice(start, end + END.length);
}

test("the screens' copy of the boxes' rules is the Inbox's block, unchanged", () => {
  expect(block(read('packages/editor/reviewLoopBoxes.css'))).toBe(block(read('packages/inbox/inbox.css')));
});

test('every box class SentThreads draws has a rule in the copy', () => {
  const source = read('packages/ui/components/inbox-thread/SentThreads.tsx');
  const classes = new Set([...source.matchAll(/\bib-sent[bc]-[a-z]+\b/g)].map((match) => match[0]));
  const copy = block(read('packages/editor/reviewLoopBoxes.css'));
  const missing = [...classes].filter((name) => !copy.includes(`.${name}`));
  expect(missing).toEqual([]);
});
