import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1032 — a block's name and its execution summary share one line.
//
// The Training Plan Templates tree rendered them as two stacked <div>s, so
// every block cost two lines of vertical space ("Press-militar" over
// "Circuit · 3 rounds") while both Workout Template trees already put the two
// on one line. This pins the compact shape, the preserved hierarchy (the
// summary stays the muted, non-bold `treeSummaryTextStyle` the sibling trees
// use) and the absence of a second colour declaration for it.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so —
// like training-plan-editor-theme.test.ts — the wiring is pinned by scanning
// the source.

const SRC = join(__dirname, '..');
const TREE = join(SRC, 'app', '[locale]', 'training-plan-templates', 'TrainingPlanTree.tsx');
const CHROME = join(SRC, 'components', 'workoutChrome.ts');

const treeSrc = readFileSync(TREE, 'utf8');
const chromeSrc = readFileSync(CHROME, 'utf8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const tree = stripComments(treeSrc);

describe('A block header is one line (#1032)', () => {
  it('nests the summary inside the name element rather than stacking two blocks', () => {
    // The name element and the summary span, in that order, with no element
    // boundary between them that would force a line break.
    expect(tree).toMatch(
      /<div style=\{\{ fontWeight: 600, fontSize: 14 \}\}>\s*\{block\.name \|\| t\(`workout_template_blocks\.type_\$\{block\.type\.toLowerCase\(\)\}`\)\}\s*<span style=\{treeSummaryTextStyle\}>\{blockSummary\(block, t\)\}<\/span>\s*<\/div>/,
    );
  });

  it('no longer renders the summary as its own block element', () => {
    expect(tree).not.toMatch(/<div style=\{\{ color: '#888', fontSize: 12\.5 \}\}>\{blockSummary/);
  });

  it('takes the summary style from the shared chrome, not a literal of its own', () => {
    expect(tree).toMatch(/import \{[^}]*\btreeSummaryTextStyle\b[^}]*\} from '@\/components\/workoutChrome'/);
    // The summary's own literal is gone; the page's remaining greys belong to
    // its empty-state paragraphs, which this ticket does not touch.
    expect(tree).not.toMatch(/color: '#888', fontSize: 12\.5/);
  });

  it('keeps the summary visually secondary to the name', () => {
    // The name is 600/14; the shared summary style is lighter and smaller, so
    // the structure information can never read stronger than the block name.
    expect(chromeSrc).toMatch(/export const treeSummaryTextStyle[\s\S]*?fontWeight: 400/);
    expect(chromeSrc).toMatch(/export const treeSummaryTextStyle[\s\S]*?fontSize: 12\.5/);
  });
});
