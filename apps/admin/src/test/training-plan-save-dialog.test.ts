import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3477 (reopened): Save on a Draft Assigned Training Plan opens one themed dialog with exactly
// Cancel, Save Draft and Save and Activate; an Active plan keeps its single Save.

const root = join(__dirname, '..', '..');
const page = readFileSync(join(root, 'src/app/[locale]/training-plans/page.tsx'), 'utf8');
const dialog = readFileSync(join(root, 'src/components/ConfirmDialog.tsx'), 'utf8');
const locale = (l: string) => JSON.parse(readFileSync(join(root, `locales/base/${l}.json`), 'utf8')).training_plans;

describe('Draft Save dialog (#3477)', () => {
  it('the editor footer offers Cancel and one Save, and Save on a Draft opens the dialog', () => {
    expect(page).not.toMatch(/onSaveAndActivate/);
    expect(page).toMatch(/if \(row\.status === 'draft'\) \{ setEditError\(null\); await openActivation\(row, true\); return; \}/);
  });

  it('the dialog from Save carries Cancel, Save Draft and Save and Activate', () => {
    expect(page).toMatch(/secondaryLabel=\{activation\?\.fromSave \? t\('training_plans\.save_draft'\)/);
    expect(page).toMatch(/onSecondary=\{activation\?\.fromSave \? saveDraftFromDialog/);
    expect(page).toMatch(/confirmLabel=\{activation\?\.fromSave \? t\('training_plans\.save_and_activate'\)/);
    expect(page).not.toMatch(/keep_draft/);
  });

  it('Save Draft persists, keeps the editor open and activates nothing', () => {
    const body = page.slice(page.indexOf('async function saveDraftFromDialog'), page.indexOf('async function confirmActivation'));
    expect(body).toMatch(/await putEdit\(row\)/);
    expect(body).not.toMatch(/\/activate/);
    expect(body).not.toMatch(/setEditingId\(null\)/);
  });

  it('a Draft saved in this session is not discarded by a later Cancel', () => {
    expect(page).toMatch(/draftRow\.id !== savedDraftId/);
  });

  it('the dialog follows the theme: no blue or red button in the primary tone', () => {
    expect(page).toMatch(/tone="primary"/);
    expect(dialog).toMatch(/const secondaryStyle = primary \? secondaryBtnStyle : btnStyle\('#2c7be5'\)/);
    expect(dialog).toMatch(/const confirmStyle = primary \? primaryBtnStyle\(\) : btnStyle\('#c0392b'\)/);
  });

  it('uses the agreed labels in every locale', () => {
    expect(locale('en').save_draft).toBe('Save Draft');
    expect(locale('en').save_and_activate).toBe('Save and Activate');
    for (const l of ['en', 'es', 'ca']) {
      for (const k of ['save_draft', 'save_and_activate', 'save_draft_title', 'save_draft_question', 'draft_saved']) {
        expect(locale(l)[k], `${l}.${k}`).toBeTruthy();
      }
    }
  });
});
