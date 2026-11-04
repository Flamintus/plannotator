import { describe, expect, test } from 'bun:test';
import { findPassage, passageContext, passageOffset, passageWindow } from './passage';

describe('a passage of words as drawn', () => {
  const words = 'Step 2 rolls back.\n\n  Step 3 rolls back too, by the off switch.';

  test('its offset counts the words with whitespace runs as one and the leading run dropped', () => {
    expect(passageOffset(words, words.indexOf('Step 3'))).toBe('Step 2 rolls back. '.length);
    expect(passageOffset('  lead', 2)).toBe(0);
  });

  test('it is found again where its offset says, though the words wrap or keep their newlines', () => {
    const offset = passageOffset(words, words.lastIndexOf('rolls back'));
    const found = findPassage(words, { quote: 'rolls  back', offset });
    expect(found).toEqual([words.lastIndexOf('rolls back'), words.lastIndexOf('rolls back') + 'rolls back'.length]);
    // The same words drawn on one line.
    const flat = words.replace(/\s+/g, ' ');
    expect(flat.slice(...findPassage(flat, { quote: 'rolls back', offset })!)).toBe('rolls back');
    expect(findPassage(flat, { quote: 'rolls back', offset })![0]).toBe(flat.lastIndexOf('rolls back'));
  });

  test('the nearest occurrence wins when its offset no longer holds it; none when the words are gone', () => {
    expect(findPassage(words, { quote: 'rolls back', offset: 3 })![0]).toBe(words.indexOf('rolls back'));
    expect(findPassage(words, { quote: 'rolls back', offset: 900 })![0]).toBe(words.lastIndexOf('rolls back'));
    expect(findPassage(words, { quote: 'feature flag', offset: 0 })).toBeNull();
    expect(findPassage(words, { quote: '  ', offset: 0 })).toBeNull();
  });

  test('the words around it are cut to about the size asked, with … where cut', () => {
    const long = `${'a '.repeat(200)}the off switch ${'b '.repeat(200)}`;
    const around = passageContext(long, { quote: 'off switch', offset: passageOffset(long, long.indexOf('off')) }, 60);
    expect(around).toContain('the off switch');
    expect(around.startsWith('…') && around.endsWith('…')).toBe(true);
    expect(around.length).toBeLessThanOrEqual(62);
    expect(passageContext('Short words.\n', { quote: 'words', offset: 6 }, 60)).toBe('Short words.');
  });

  test('the cut says where the passage starts in it, so a reader of the cut finds it there', () => {
    const long = `${'a '.repeat(200)}the off switch ${'b '.repeat(200)}`;
    const cut = passageWindow(long, { quote: 'off switch', offset: passageOffset(long, long.indexOf('off')) }, 60);
    expect(cut.text.slice(cut.offset).startsWith('off switch')).toBe(true);
    expect(passageWindow('  Short  words.', { quote: 'words', offset: 6 }, 60)).toEqual({ text: 'Short words.', offset: 6 });
  });
});
