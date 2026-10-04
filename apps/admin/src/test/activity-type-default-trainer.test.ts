import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #986 — the Activity Type's Default Trainer lookup.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like class-session-detail-edit.test.ts (#980) — the structure is
// pinned down by scanning the page source. What is worth pinning is the half of
// the ticket that is a *rule* rather than markup: which set the dropdown offers
// (the server's, unfiltered), and that the trainer an activity already holds is
// still readable after that person leaves.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'activity-types', 'page.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

describe('Default Trainer lookup (#986)', () => {
  it('reads the lookup from the server once and narrows it nowhere', () => {
    expect((pageSrc.match(/apiFetch<Trainer\[\]>\('\/trainers'\)/g) ?? []).length).toBe(1);
    // §1: no role, center or professional-service condition in the page. The
    // eligible set is the server's (domain/trainerAssignment.ts) — a
    // `trainers.filter(...)` here would be a second, divergent rule.
    expect(pageSrc).not.toMatch(/trainers\s*\.\s*filter\(/);
  });

  it('offers the stored trainer as a disabled option so it still reads (§3)', () => {
    const options = pageSrc.match(/const trainerOptions = \[[\s\S]*?\];/)?.[0] ?? '';
    expect(options).toContain('row.default_trainer_membership_id');
    // The name comes from the row the list already carries — no second read.
    expect(options).toContain('row.default_trainer_name');
    expect(options).toContain('unavailable: true');

    const select = (pageSrc.match(/<select[\s\S]*?<\/select>/g) ?? [])
      .find((s) => s.includes('default_trainer_membership_id'));
    expect(select).toBeDefined();
    expect(select).toContain('trainerOptions.map');
    expect(select).toContain('disabled={tr.unavailable}');
    // An unassigned activity still reads as "—" rather than as the first staff
    // member in the list.
    expect(select).toContain('<option value="">—</option>');
  });

  it('submits the selected id, parsed, and never a name', () => {
    const payload = pageSrc.match(/default_trainer_membership_id: editForm[\s\S]{0,120}/)?.[0] ?? '';
    expect(payload).toContain('parseInt(editForm.default_trainer_membership_id, 10)');
    // An empty select is an explicit clear, which the route accepts as null.
    expect(payload).toContain(': null');
    // `default_trainer_name` is the read's own display field: it reaches the
    // disabled option and the list header, never the payload.
    const saveBody = pageSrc.match(/body: JSON\.stringify\(\{[\s\S]*?\}\)/g) ?? [];
    for (const body of saveBody) expect(body).not.toContain('default_trainer_name');
  });
});
