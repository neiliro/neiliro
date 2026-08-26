import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inlineDanger } from '../components/Dialog';

/*
  Destructive actions have exactly two shapes, and this keeps it that way
  (#79).

  The issue was not that the styling was wrong — it was that the same
  decision had been re-made per file, five slightly different ways, until
  nobody could tell which was the convention. Fixing the copies once does
  not fix that; the next inline delete would start a sixth. So the rule
  lives here, where adding a raw copy fails a test instead of passing
  review unnoticed.

  Icon-only controls are intentionally out of scope: a ✕ next to a receipt
  or a bin glyph in a row is not competing with the text-link convention,
  it is a different control.
*/

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the constant is defined — the one file allowed to hold the string. */
const DEFINITION = join(SRC, 'components', 'Dialog.tsx');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('destructive actions', () => {
  const files = sourceFiles(SRC);

  it('found the source tree at all', () => {
    // Guards the walk itself: a broken path would make every check below
    // pass by testing nothing
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(DEFINITION);
  });

  it('has no hand-rolled copies of the inline style', () => {
    const offenders = files
      .filter((path) => path !== DEFINITION)
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        // An underlined control that turns urgent on hover is the inline
        // convention, whichever order the classes were written in
        return /underline[^"'`]*hover:text-urgent|hover:text-urgent[^"'`]*underline/.test(text);
      })
      .map((path) => path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('is actually used, in more than one place', () => {
    const users = files.filter((path) => readFileSync(path, 'utf8').includes('inlineDanger'));
    // If this ever drops to just the definition, the constant has been
    // quietly abandoned rather than adopted
    expect(users.length).toBeGreaterThan(5);
  });

  it('carries no font size, so call sites keep their own', () => {
    /*
      This is the mistake the first attempt at #79 made: baking text-sm
      into the constant silently grew the compact rows — the session
      revoke button sat at text-xs beside a font-mono text-xs address and
      a text-[0.625rem] badge, and became the largest thing in the row.
    */
    expect(inlineDanger).not.toMatch(/\btext-(xs|sm|base|lg|\[)/);
    // And it still has to carry the decision it exists for
    expect(inlineDanger).toContain('hover:text-urgent');
    expect(inlineDanger).toContain('underline');
  });
});
