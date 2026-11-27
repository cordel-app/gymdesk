import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { blockCredits, blockLevelOn, dayCompletion, dayStatus, withBlockLevel } from '../lib/trainingDayStatus';
import { dayIndicatorBackground } from '../lib/nutritionDayIndicator';
import { workoutBlockCounter } from '../lib/trainingWorkoutHeading';

// #3494 — Fully Done / Partially Done and the proportional day circle.
// 2026-10-14 is a Wednesday (weekday 3).
const D = '2026-10-14';
const workouts = [
  { scheduled_weekday: 3, blocks: [{ id: 1 }, { id: 2 }] },
  { scheduled_weekday: null, blocks: [{ id: 3 }] },
];

describe('training completion (#3494)', () => {
  it('Partially Done is half of Fully Done, and the day is the mean over its workouts', () => {
    expect(dayCompletion(D, 3, workouts, [])).toBe(0);
    expect(dayCompletion(D, 3, workouts, [{ workout_block_id: 1, logged_date: D }])).toBe(25);
    expect(dayCompletion(D, 3, workouts, [{ workout_block_id: 1, logged_date: D, level: 'partial' }])).toBe(13);
    const all = [1, 2, 3].map((id) => ({ workout_block_id: id, logged_date: D, level: 'done' }));
    expect(dayCompletion(D, 3, workouts, all)).toBe(100);
    expect(dayStatus(D, 3, D, workouts, all)).toBe('completed');
    expect(dayCompletion(D, 2, [{ scheduled_weekday: 3, blocks: [{ id: 1 }] }], [])).toBeNull();
  });

  it('switching levels replaces the contribution and a repeat adds nothing', () => {
    let logs = withBlockLevel([], 1, D, 'partial');
    logs = withBlockLevel(logs, 1, D, 'partial');
    expect(logs).toHaveLength(1);
    expect(blockLevelOn(blockCredits(logs, D), 1)).toBe('partial');
    logs = withBlockLevel(logs, 1, D, 'done');
    expect(blockCredits(logs, D).get(1)).toBe(1);
    logs = withBlockLevel(logs, 1, D, 'partial');
    expect(blockCredits(logs, D).get(1)).toBe(0.5);
    expect(dayStatus(D, 3, D, [{ scheduled_weekday: 3, blocks: [{ id: 1 }] }], logs)).toBe('pending');
  });

  it('the workout counter counts a Partially Done block as a half', () => {
    const credits = blockCredits([{ workout_block_id: 1, logged_date: D, level: 'partial' }, { workout_block_id: 2, logged_date: D }], D);
    expect(workoutBlockCounter({ description: null, blocks: [{ id: 1, position: 1, exercises: [] }, { id: 2, position: 2, exercises: [] }] }, credits))
      .toEqual({ done: 1.5, total: 2 });
  });

  it('the day circle fills green in proportion to the completion', () => {
    const colors = { success: 'G', error: 'R', status: { completed: 'G', partial: 'P', pending: 'R', scheduled: 'Y', rest: 'X' } };
    expect(dayIndicatorBackground('pending', 0, colors)).toBe('R');
    expect(dayIndicatorBackground('pending', 25, colors)).toBe('conic-gradient(G 0% 25%, R 25% 100%)');
    expect(dayIndicatorBackground('pending', 63, colors)).toBe('conic-gradient(G 0% 63%, R 63% 100%)');
    expect(dayIndicatorBackground('completed', 100, colors)).toBe('G');
  });

  it('every Mark done of the page is the Fully Done / Partially Done pair', () => {
    const page = readFileSync(join(__dirname, '..', 'app', '[locale]', 'training', 'page.tsx'), 'utf-8');
    expect(page).not.toContain('training.mark_done');
    expect(page).toContain("markBlockDone(block, 'done')");
    expect(page).toContain("markBlockDone(block, 'partial')");
    expect(page).toContain('dayIndicatorBackground(status, completion, INDICATOR_COLORS)');
  });
});
