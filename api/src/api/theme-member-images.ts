// Reading the Members image rows of one or more themes (#725).
//
// One place, because three routers return a theme-shaped response and all three
// must agree on what a theme's Members configuration is: `gym-themes.ts` (the
// editor), `me.ts` (`/me/gym` and `/me/gyms`, which is what the Members App
// actually renders from) and any future consumer. The shaping itself is pure
// and lives in `domain/themeMemberImages.ts`; this file only fetches.

import { db } from '../infra/db';
import type { MemberImageRow } from '../domain/themeMemberImages';

/** Groups `SELECT theme_id, slot, …` rows the way every caller here wants them. */
function groupByTheme(rows: (MemberImageRow & { theme_id: string })[]): Map<string, MemberImageRow[]> {
  const byTheme = new Map<string, MemberImageRow[]>();
  for (const row of rows) {
    const list = byTheme.get(row.theme_id) ?? [];
    list.push(row);
    byTheme.set(row.theme_id, list);
  }
  return byTheme;
}

/**
 * The Members image rows of the given themes, grouped by `theme_id` — one query
 * for a whole list of themes, which is what #725's "do not make six separate
 * API requests" rules out the alternative of.
 *
 * `gymIds` is always applied (CLAUDE.md: every query filters by `gym_id`), even
 * though `theme_id` already implies the gym: it is the table's own column, so
 * the tenant filter never depends on a join. `themeIds` is optional — omitted,
 * the whole gym's rows come back, which is what an "everything this gym owns"
 * read wants.
 *
 * #732: when the caller *names* the themes, a Base Theme's own rows
 * (`gym_id IS NULL`, migration 182) come back too. That is not a hole in the
 * tenant filter — a Base Theme belongs to the platform and is readable by every
 * gym, exactly as the theme row itself is, and the gym could not have named the
 * id without being served the theme first. It is also the only way the Members
 * App can paint the backgrounds of a gym running a Base Theme. Without
 * `themeIds` the query stays strictly this gym's, so a list of Custom Themes
 * can never pick up a platform row for a theme it is not showing.
 */
export async function loadMemberImagesByTheme(
  gymIds: string[],
  themeIds?: string[],
): Promise<Map<string, MemberImageRow[]>> {
  const gyms = gymIds.filter((id): id is string => !!id);
  if (gyms.length === 0) return new Map();
  if (themeIds && themeIds.length === 0) return new Map();

  const gymClause = `gym_id IN (${gyms.map(() => '?').join(',')})`;
  const params: any[] = [...gyms];
  let where = gymClause;
  if (themeIds) {
    where = `(${gymClause} OR gym_id IS NULL) AND theme_id IN (${themeIds.map(() => '?').join(',')})`;
    params.push(...themeIds);
  }
  const { rows } = await db.query<MemberImageRow & { theme_id: string }>(
    `SELECT theme_id, slot, object_key, modified_at FROM theme_member_images WHERE ${where}`,
    params,
  );
  return groupByTheme(rows);
}

/**
 * The platform's own Members image rows (#732), grouped by `theme_id` — the
 * Base Theme counterpart of the read above, for the superadmin router, which
 * has no gym to filter by. `gym_id IS NULL` is the filter: it is what makes a
 * row the platform's, and it means a Custom Theme's rows can never reach a
 * Base Theme response.
 */
export async function loadPlatformMemberImagesByTheme(
  themeIds?: string[],
): Promise<Map<string, MemberImageRow[]>> {
  if (themeIds && themeIds.length === 0) return new Map();
  const params: any[] = [];
  let themeClause = '';
  if (themeIds) {
    themeClause = ` AND theme_id IN (${themeIds.map(() => '?').join(',')})`;
    params.push(...themeIds);
  }
  const { rows } = await db.query<MemberImageRow & { theme_id: string }>(
    `SELECT theme_id, slot, object_key, modified_at FROM theme_member_images
     WHERE gym_id IS NULL${themeClause}`,
    params,
  );
  return groupByTheme(rows);
}
