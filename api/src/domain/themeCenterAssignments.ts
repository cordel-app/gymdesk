/**
 * #985 — a Theme's Center assignments are **one replace-all set**, not a pair of
 * add/remove actions.
 *
 * `centers.theme_id` is nullable: a non-NULL value is that Center's own, explicit
 * assignment, and NULL means the Center follows `gyms.theme_id` (the Gym Default
 * Theme). So "assigned to this theme" is `centers.theme_id = <theme>` and
 * un-assigning is writing NULL back — which is what `DELETE
 * /system/themes/:id/centers/:centerId` ("Restore Inheritance") did before this
 * ticket, and what an unticked checkbox means now.
 *
 * This module decides *what moves* for a submitted set and nothing else, so the
 * route stays two UPDATEs and the rule is assertable without a database:
 *
 * - `assign` — the requested Centers not already pointing at this theme.
 * - `clear`  — the Centers pointing at this theme that the request left out.
 *
 * A Center pointing at *another* theme and left out of the request is in neither
 * list: the submitted set is this theme's assignments, never every Center's.
 */

export interface ThemeCenterRow {
  id: string;
  theme_id: string | null;
}

export interface ThemeCenterAssignmentPlan {
  assign: string[];
  clear: string[];
}

/** The requested ids that are not Centers of this gym (a 400, never ignored). */
export function unknownCenterIds(centers: ThemeCenterRow[], requested: string[]): string[] {
  const known = new Set(centers.map((c) => c.id));
  return dedupe(requested).filter((id) => !known.has(id));
}

export function themeCenterAssignmentPlan(
  centers: ThemeCenterRow[],
  themeId: string,
  requested: string[],
): ThemeCenterAssignmentPlan {
  const wanted = new Set(dedupe(requested));
  const assign: string[] = [];
  const clear: string[] = [];
  for (const center of centers) {
    const holdsTheme = center.theme_id === themeId;
    if (wanted.has(center.id)) {
      if (!holdsTheme) assign.push(center.id);
    } else if (holdsTheme) {
      clear.push(center.id);
    }
  }
  return { assign, clear };
}

/** The Centers explicitly assigned to this theme, as stored. */
export function assignedCenterIds(centers: ThemeCenterRow[], themeId: string): string[] {
  return centers.filter((c) => c.theme_id === themeId).map((c) => c.id);
}

export function planChangesNothing(plan: ThemeCenterAssignmentPlan): boolean {
  return plan.assign.length === 0 && plan.clear.length === 0;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
