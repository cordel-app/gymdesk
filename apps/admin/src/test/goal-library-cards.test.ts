import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1830 — Personal Goals and Base Personal Goals take the Cards view through the
// one GoalLibrarySection, reusing Exercises' and Activities' shared pieces.
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const section = read('components', 'goalLibrary', 'GoalLibrarySection.tsx');

describe('goal library cards view (#1830)', () => {
  it('reuses the shared toggle, saved view mode and card grid', () => {
    expect(section).toContain("useExerciseViewMode");
    expect(section).toContain('<ExerciseViewToggle');
    expect(section).toContain('<CardGrid>');
  });

  it('Edit switches to the List view before opening the row in edit mode', () => {
    expect(section).toMatch(/function openInlineEdit[\s\S]*?setView\('list'\)[\s\S]*?setEditingId\(goal\.id\)/);
  });

  it('draws Show / Hide all attributes from the goal_library namespace in every language', () => {
    for (const l of ['en', 'es', 'ca']) {
      const d = JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf8'));
      expect(d.goal_library.show_all_attributes).toBeTruthy();
      expect(d.goal_library.hide_all_attributes).toBeTruthy();
    }
  });

  it('one menu-item list serves the list column and the card header', () => {
    expect(section.match(/menuItemsFor\(goal\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
