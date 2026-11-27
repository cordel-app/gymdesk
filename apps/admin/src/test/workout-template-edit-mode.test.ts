import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #3485: a Workout Template's (gym and Base) content is editable in Edit mode
// only, and Cancel discards the whole edit session through the server's checkpoint.
const APP = join(__dirname, '..', 'app', '[locale]');
const gym = readFileSync(join(APP, 'workout-templates', 'page.tsx'), 'utf-8');
const base = readFileSync(join(APP, 'cordel', 'workout-templates', 'page.tsx'), 'utf-8');

describe('Workout Template edit mode (#3485)', () => {
  it('renders the gym tree read-only outside Edit mode', () => {
    expect(gym).toContain('canWrite={!!canWrite && isEditing}');
    expect(gym).toContain('canWrite={false}');
    expect(gym).not.toContain('canWrite={!!canWrite}\n');
  });

  it('renders the Base tree read-only outside Edit mode', () => {
    expect(base).toContain('renderTree(tpl, true)');
    expect(base).toContain('renderTree(tpl, false)');
  });

  it('opens, cancels and closes an edit session on the server, on both pages', () => {
    for (const page of [gym, base]) {
      expect(page).toContain("/edit-session`, { method: 'POST' }");
      expect(page).toContain("/edit-session/cancel`, { method: 'POST' }");
      expect(page).toContain("/edit-session`, { method: 'DELETE' }");
    }
  });

  it('no longer edits a Base template in a modal', () => {
    expect(base).not.toContain('base_modal_edit');
  });
});
