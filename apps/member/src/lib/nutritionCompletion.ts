// #1580: which completion actions My Nutrition offers for an item on a date. Pure — the page draws,
// the server (POST /me/nutrition-logs, /me/nutrition-requirement-logs) still enforces the same rules.
export type NutritionItemKind = 'meal' | 'goal' | 'restriction';
export type CompletionLevel = 'partial' | 'done' | undefined;

export interface CompletionActions {
  done: boolean;
  partial: boolean;
  showMarkDone: boolean;
  showPartiallyDone: boolean;
}

// Only a dietary restriction has a Partially Done state (#1610 decision); a meal and a goal are
// done or not. A future date offers nothing, and a completed item offers nothing.
export function completionActions(kind: NutritionItemKind, level: CompletionLevel, selectedDate: string, today: string): CompletionActions {
  const done = level === 'done';
  const partial = level === 'partial';
  const open = !done && selectedDate <= today;
  return {
    done,
    partial,
    showMarkDone: open,
    showPartiallyDone: open && !partial && kind === 'restriction',
  };
}
