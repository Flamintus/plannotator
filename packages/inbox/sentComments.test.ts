import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { codeCommentAnnotation, codeRangeOf } from './attachments';
import { followCodeLines, sentUnanchoredChanges } from './sentComments';

const sent = (id: string, unanchored_at: string | null = null) => ({ id, unanchored_at, sent_reply_id: 'msg_p1' }) as unknown as InboxAnnotationRecord;

describe('what the window keeps of a sent comment it placed', () => {
  test('a change is sent only when what the window found differs from what is kept', () => {
    const records = [sent('lost'), sent('back', '2026-11-04T10:00:00.000Z'), sent('still', '2026-11-04T10:00:00.000Z'), sent('fine')];
    expect(sentUnanchoredChanges(records, { attempted: ['lost', 'back', 'still', 'fine'], unanchored: ['lost', 'still'] })).toEqual([
      { id: 'lost', unanchored: true },
      { id: 'back', unanchored: false },
    ]);
  });

  test('a comment the window did not try to place keeps its state (a first paint before the file was read)', () => {
    expect(sentUnanchoredChanges([sent('kept', '2026-11-04T10:00:00.000Z')], { attempted: [], unanchored: [] })).toEqual([]);
  });
});

describe('a sent code comment follows its lines', () => {
  const comment = codeCommentAnnotation({ id: 'c1', lineStart: 2, lineEnd: 3, text: 'why twice?', code: 'retry()\nretry()' });

  test('lines added above move it to where its lines are now', () => {
    const moved = followCodeLines(comment, ['// new', '// new', 'start()', 'retry()', 'retry()', 'end()']);
    expect(codeRangeOf(moved)).toMatchObject({ lineStart: 4, lineEnd: 5 });
    // The export and the panel read the lines from blockId.
    expect(moved.blockId).toBe('code-L4-5');
  });

  test('lines still in place, or gone, leave it as it is', () => {
    expect(followCodeLines(comment, ['start()', 'retry()', 'retry()'])).toBe(comment);
    expect(followCodeLines(comment, ['start()', 'retry()', 'done()'])).toBe(comment);
  });
});
