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
 * - `assigned` — what the set reads as once those two have run.
 *
 * A Center pointing at *another* theme and left out of the request is in neither
 * list: the submitted set is this theme's assignments, never every Center's.
 *
 * A Center id is an **auto-increment integer** (`centers.id`, migration 043), so
 * it reaches a JSON request as a number and comes back from a browser that kept
 * it as a string. Every comparison here is therefore on `centerKey()` and the
 * ids reported back are the *stored* ones — a route that compared the two forms
 * directly would answer "center not found" for every real Center.
 */

export type CenterId = string | number;

export interface ThemeCenterRow {
  id: CenterId;
  theme_id: string | null;
}

export interface ThemeCenterAssignmentPlan {
  assign: CenterId[];
  clear: CenterId[];
  assigned: CenterId[];
}

/** The one spelling every comparison in this module (and in the admin) uses. */
export function centerKey(id: CenterId): string {
  return String(id);
}

/** The requested ids that are not Centers of this gym (a 400, never ignored). */
export function unknownCenterIds(centers: ThemeCenterRow[], requested: CenterId[]): CenterId[] {
  const known = new Set(centers.map((c) => centerKey(c.id)));
  return dedupe(requested).filter((id) => !known.has(centerKey(id)));
}

export function themeCenterAssignmentPlan(
  centers: ThemeCenterRow[],
  themeId: string,
  requested: CenterId[],
): ThemeCenterAssignmentPlan {
  const wanted = new Set(dedupe(requested).map(centerKey));
  const assign: CenterId[] = [];
  const clear: CenterId[] = [];
  const assigned: CenterId[] = [];
  for (const center of centers) {
    const holdsTheme = center.theme_id === themeId;
    if (wanted.has(centerKey(center.id))) {
      assigned.push(center.id);
      if (!holdsTheme) assign.push(center.id);
    } else if (holdsTheme) {
      clear.push(center.id);
    }
  }
  return { assign, clear, assigned };
}

/** The Centers explicitly assigned to this theme, as stored. */
export function assignedCenterIds(centers: ThemeCenterRow[], themeId: string): CenterId[] {
  return centers.filter((c) => c.theme_id === themeId).map((c) => c.id);
}

export function planChangesNothing(plan: ThemeCenterAssignmentPlan): boolean {
  return plan.assign.length === 0 && plan.clear.length === 0;
}

function dedupe(ids: CenterId[]): CenterId[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = centerKey(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
