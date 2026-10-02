import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #966 — expanding a Training Plan Template must not strand the row on
// `Loading…`.
//
// The body rendered the tree only once the hierarchy had arrived and showed
// `Loading…` for every other state, so the failed request (the backend was
// selecting a dropped column) left the row loading for ever and the only report
// was a transient toast carrying a raw SQL message. The row now keeps the
// failure, says so in the viewer's language and offers Retry.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so —
// like section-edit-button.test.ts and plans-expanded-read-only.test.ts — the
// wiring is pinned by scanning the page source, and the locale files directly.

const SRC = join(__dirname, '..');
const PAGE = join(SRC, 'app', '[locale]', 'training-plan-templates', 'page.tsx');
const SUMMARIES = join(SRC, 'app', '[locale]', 'workout-templates', 'summaries.ts');
const LOCALES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const page = stripComments(readFileSync(PAGE, 'utf8'));

describe('the expanded row keeps a failed hierarchy load', () => {
  it('holds the failure per template, beside the cached hierarchies', () => {
    expect(page).toContain('const [hierError, setHierError] = useState<Record<number, string>>({})');
  });

  it('records the failure where it used to only toast', () => {
    expect(page).toContain("setHierError((prev) => ({ ...prev, [id]: err.message ?? t('hierarchy_error') }))");
  });

  it('clears the failure when the load is retried', () => {
    // The retry has to get past the `hierarchies[id]` early return, which is
    // what made the old guard unable to reload anything.
    expect(page).toContain('async function loadHierarchy(id: number, opts: { retry?: boolean } = {})');
    expect(page).toContain('if (hierarchies[id] && !opts.retry) return;');
    expect(page).toContain('onRetryHierarchy={() => loadHierarchy(row.id, { retry: true })}');
  });

  it('renders the tree, then loading, then the error — never loading on a failure', () => {
    expect(page).toContain(') : hierLoading || !hierError ? (');
    expect(page).toContain("{t('hierarchy_error')}");
    expect(page).toContain("{t('retry')}");
    // Retry is a recovery affordance, so it wears the shared neutral button
    // rather than a hex of its own (#912/#929/#954).
    expect(page).toContain('style={secondaryBtnSmall}');
    // The old shape, which could not tell "still loading" from "failed".
    expect(page).not.toContain('{hierLoading || !hierarchy ? (');
  });

  it('passes both down to the card as typed props', () => {
    expect(page).toContain('hierError: string | null;');
    expect(page).toContain('onRetryHierarchy: () => void;');
  });
});

describe('the two new labels exist in every locale', () => {
  for (const locale of LOCALES) {
    it(`${locale} has hierarchy_error and retry under training_plan_templates`, () => {
      const json = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', `${locale}.json`), 'utf8'));
      const ns = json.training_plan_templates;
      for (const key of ['hierarchy_error', 'retry']) {
        expect(typeof ns[key]).toBe('string');
        expect(ns[key].trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe('the block/exercise contract the tree renders through', () => {
  const summaries = stripComments(readFileSync(SUMMARIES, 'utf8'));

  it('still has no block-level result type — it is the exercise\'s (#154)', () => {
    // Both trees render through this one declaration, and it has described the
    // post-migration-074 shape all along; the hierarchy query is what drifted.
    expect(summaries).not.toMatch(/result_type\s*:/);
    expect(summaries).toContain('result_type_slug: string | null');
  });
});
