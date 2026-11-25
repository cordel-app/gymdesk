/**
 * #3335 stage 2: what the two Workout Template lists (a gym's own and Cordel's
 * Base one) share beyond their column declaration — the Source a row reads as,
 * whether it can be resynced, and the block count it shows. Pure (no React, no
 * `t()`), so both pages and the test assert one answer.
 *
 * The Source rule is the Training Plan Templates' one (#3334), re-exported
 * rather than restated: a gym row is `system` when the API derived it from
 * `cloned_from_id`, a Base row (`gym_id === null`) is the System row itself.
 */
export {
  templateSource, canResyncWithSystem, type TemplateSource,
} from '../training-plan-templates/trainingPlanTemplateList';

/**
 * The template's number of blocks. The API derives `num_blocks` on read (never
 * stored, #3335 stage 1); an older payload carries only `blocks_count`, and
 * mysql2 may answer either as a string. Anything unusable reads as 0.
 */
export function toNumBlocks(row: { num_blocks?: unknown; blocks_count?: unknown }): number {
  for (const raw of [row.num_blocks, row.blocks_count]) {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) return n;
  }
  return 0;
}
