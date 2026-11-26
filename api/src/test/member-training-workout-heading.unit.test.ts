import { describe, expect, it } from 'vitest';
import {
  firstWorkoutExercise,
  groupWorkoutsByPlan,
  workoutBlockCounter,
  workoutNotes,
  workoutThumbnailView,
} from '../../../apps/member/src/lib/trainingWorkoutHeading';

// #3465 — My Training's Workout heading: thumbnail, notes, done/total blocks
// and the plan name once. In the API suite because CI runs `npm test` in `api/` only.

const ex = (position: number, name: string, img: string | null = null, thumb: string | null = null) => ({
  position, exercise_name: name, exercise_image_url: img, exercise_image_thumbnail_url: thumb,
});

describe('workout thumbnail', () => {
  it('uses the first exercise in block then exercise order', () => {
    const workout = {
      description: null,
      blocks: [
        { id: 2, position: 2, exercises: [ex(1, 'Row', 'row.webp')] },
        { id: 1, position: 1, exercises: [ex(2, 'Squat', 'squat.webp', 'squat-t.webp'), ex(1, 'Press', 'press.webp', 'press-t.webp')] },
      ],
    };
    expect(firstWorkoutExercise(workout)?.exercise_name).toBe('Press');
    expect(workoutThumbnailView(workout)).toEqual({ thumbnailSrc: 'press-t.webp', fullSrc: 'press.webp', exerciseName: 'Press' });
  });

  it('skips empty blocks and falls back to the master when there is no thumbnail', () => {
    const workout = { description: null, blocks: [{ id: 1, position: 1, exercises: [] }, { id: 2, position: 2, exercises: [ex(1, 'Row', 'row.webp')] }] };
    expect(workoutThumbnailView(workout).thumbnailSrc).toBe('row.webp');
  });

  it('has no picture (the WO placeholder) for a workout with no exercises', () => {
    expect(workoutThumbnailView({ description: null, blocks: [{ id: 1, position: 1, exercises: null }] }).thumbnailSrc).toBeNull();
    expect(workoutThumbnailView({ description: null, blocks: null }).thumbnailSrc).toBeNull();
  });
});

describe('workout block counter', () => {
  const workout = {
    description: null,
    blocks: [
      { id: 10, position: 1, exercises: [ex(1, 'A'), ex(2, 'B'), ex(3, 'C')] },
      { id: 11, position: 2, exercises: [ex(1, 'D')] },
    ],
  };

  it('counts blocks, not exercises', () => {
    expect(workoutBlockCounter(workout, new Set())).toEqual({ done: 0, total: 2 });
  });

  it('follows the done set, ignoring other workouts\' blocks', () => {
    expect(workoutBlockCounter(workout, new Set([10, 99]))).toEqual({ done: 1, total: 2 });
    expect(workoutBlockCounter(workout, new Set([10, 11]))).toEqual({ done: 2, total: 2 });
  });
});

describe('workout notes', () => {
  it('reads the description, blank as none', () => {
    expect(workoutNotes({ description: '  Warm up first ', blocks: null })).toBe('Warm up first');
    expect(workoutNotes({ description: '   ', blocks: null })).toBeNull();
    expect(workoutNotes({ description: null, blocks: null })).toBeNull();
  });
});

describe('plan name shown once', () => {
  it('groups workouts under their plan in order of first appearance', () => {
    const a = { id: 1, name: 'A' };
    const b = { id: 2, name: 'B' };
    const groups = groupWorkoutsByPlan([
      { plan: a, workout: 'a1' }, { plan: b, workout: 'b1' }, { plan: a, workout: 'a2' },
    ]);
    expect(groups).toEqual([{ plan: a, workouts: ['a1', 'a2'] }, { plan: b, workouts: ['b1'] }]);
  });
});
