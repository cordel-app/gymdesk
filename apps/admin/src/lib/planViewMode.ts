/**
 * Which presentation the Membership Plans page uses (#1369): the card grid or
 * the existing expandable list. Pure, like `exerciseViewMode.ts`: Cards is the
 * default on a first visit, a saved choice wins afterwards, and every storage
 * access is guarded because `localStorage` can throw.
 */
export const PLAN_VIEW_MODES = ['cards', 'list'] as const;
export type PlanViewMode = (typeof PLAN_VIEW_MODES)[number];
export const DEFAULT_PLAN_VIEW_MODE: PlanViewMode = 'cards';
export const PLAN_VIEW_MODE_STORAGE_KEY = 'gd-plan-view-mode';

export function parsePlanViewMode(value: unknown): PlanViewMode {
  return value === 'list' || value === 'cards' ? value : DEFAULT_PLAN_VIEW_MODE;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readPlanViewMode(storage: StorageLike | null | undefined): PlanViewMode {
  try {
    return parsePlanViewMode(storage?.getItem(PLAN_VIEW_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_PLAN_VIEW_MODE;
  }
}

export function writePlanViewMode(storage: StorageLike | null | undefined, mode: PlanViewMode): void {
  try {
    storage?.setItem(PLAN_VIEW_MODE_STORAGE_KEY, mode);
  } catch { /* a per-viewer convenience: losing it costs nothing */ }
}
