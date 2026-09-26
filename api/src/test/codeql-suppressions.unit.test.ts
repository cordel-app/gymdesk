import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// #767 — CodeQL suppression comments do not work in this repository.
//
// Both documented forms were pushed to the same alert and the code-scanning
// results check stayed red on each: `// codeql[js/xss-through-dom]` on the
// preceding line, and a trailing `// lgtm[js/xss-through-dom]`. GitHub's
// advanced setup here honours neither, so such a comment suppresses nothing —
// it only tells the next reader the alert is handled when it is not. That is
// how the two `// lgtm[js/missing-rate-limiting]` comments in `app.ts` survived
// unnoticed until #767.
//
// An alert is cleared by fixing the code, by a human dismissing it in
// Security → Code scanning, or by an owner-authorized merge that records the
// assessment — see "Code scanning (CodeQL)" in docs/architecture.md. This test
// is the part of that decision the build can enforce: reasoning at a sink is
// welcome as prose, a directive that does nothing is not.
//
// A unit test — it reads the tree and touches neither the DB nor HTTP.

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The packages CodeQL analyses (`javascript-typescript`). `apps/payment` is
// static HTML served by nginx and has no source tree of its own.
const SCANNED_DIRS = [
  join('api', 'src'),
  join('apps', 'admin', 'src'),
  join('apps', 'member', 'src'),
];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * A real directive: a comment that *starts* with `lgtm[...]` / `codeql[...]`, in either
 * position CodeQL documents — a line of its own above the sink, or trailing the sink.
 *
 * Backticked spans are stripped before the test, so prose may quote the forms (the
 * justification in `exerciseVideoUpload.ts` names both, to stop the next reader repeating
 * the experiment) without reading as one.
 */
const SUPPRESSION = /(?:^|[\s;)}])(?:\/\/|\/\*)\s*(?:lgtm|codeql)\s*\[/i;

const stripInlineCode = (line: string) => line.replace(/`[^`]*`/g, '``');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(path);
    }
  }
  return found;
}

describe('#767 CodeQL suppression comments', () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)));

  it('finds the source trees it is meant to guard', () => {
    // A wrong REPO_ROOT would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(200);
  });

  it('no source file carries an inert `lgtm[...]` or `codeql[...]` directive', () => {
    const offenders: string[] = [];

    for (const file of files) {
      // This test file names both forms on purpose; exclude itself.
      if (file === __filename) continue;
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (SUPPRESSION.test(stripInlineCode(line))) {
          offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        }
      });
    }

    expect(
      offenders,
      'A CodeQL/LGTM suppression comment does nothing in this repo (#767). Clear the alert ' +
        'per "Code scanning (CodeQL)" in docs/architecture.md and keep the reasoning as prose.',
    ).toEqual([]);
  });
});
