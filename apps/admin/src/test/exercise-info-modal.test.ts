import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildExerciseInfo, exerciseInfoFields } from '../components/exercises/exerciseInfoView';

// #2203 — the details modal opened from an Assigned Training Plan exercise.
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('exercise info view (#2203)', () => {
  it('prefers localized content and lists only fields with content', () => {
    const info = buildExerciseInfo({
      name: 'Bench Press', display_name: 'Press de banca',
      short_description: 'short', display_short_description: 'corta',
      description: null, display_description: '  ',
      category: 'strength', muscles: [{ key: 'chest', role: 'principal' }],
      effective_image_url: 'https://x/y.webp',
    });
    expect(info.name).toBe('Press de banca');
    expect(info.shortDescription).toBe('corta');
    expect(info.description).toBeNull();
    expect(exerciseInfoFields(info)).toEqual(['short_description', 'muscles', 'categories']);
  });

  it('survives an exercise with nothing but a name', () => {
    const info = buildExerciseInfo({ name: 'Plank' });
    expect(info.imageUrl).toBeNull();
    expect(exerciseInfoFields(info)).toEqual([]);
  });
});

describe('exercise info wiring (#2203)', () => {
  const builder = read('app', '[locale]', 'workout-templates', 'WorkoutBlockBuilder.tsx');
  it('opens the same modal from the image and the name', () => {
    expect(builder).toContain('exercise-info-open-image');
    expect(builder).toContain('exercise-info-open-name');
    expect(builder.match(/<ExerciseInfoModal/g)).toHaveLength(1);
  });
  it('is the builder both Assigned Training Plans views render', () => {
    expect(read('app', '[locale]', 'training-plans', 'PlanWorkoutTree.tsx')).toContain('WorkoutBlockBuilder');
    expect(read('app', '[locale]', 'members', 'MemberExpandedRow.tsx')).toContain('PlanWorkoutTree');
  });
  it('draws a monochrome icon per field with no colour of its own', () => {
    const modal = read('components', 'exercises', 'ExerciseInfoModal.tsx');
    expect(modal).toContain('stroke="currentColor"');
    expect(modal).not.toMatch(/<svg[^>]*(fill|stroke)="#/);
  });
});
