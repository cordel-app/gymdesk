// #2609 stage 3 — which units of a plan's Individual Products go to which family member,
// as the Assigned Plan card shows and edits them. Pure: no React, no `t()`, no request.
// The distribution itself (the default, what a stored choice resolves to) is the server's
// (`api/src/domain/planUnitAssignees.ts`); this module only shapes and diffs it.

export type UnitSection = 'oneoff' | 'session' | 'periodical';

export interface UnitAssigneeLine {
  section: UnitSection;
  product_id: number;
  item_name: string;
  /** One member id per unit, as the server reported them. */
  assignees: number[];
  names: string[];
}

interface SnapshotLike {
  oneoff_benefits: { product_id: number; item_name: string; unit_assignees?: { member_id: number; name: string }[] | null }[];
  session_benefits: SnapshotLike['oneoff_benefits'];
  periodical_benefits: SnapshotLike['oneoff_benefits'];
}

/** The lines that carry a per-unit assignee (Individual Products), in the card's section order. */
export function unitAssigneeLines(snapshot: SnapshotLike): UnitAssigneeLine[] {
  const sections: [UnitSection, SnapshotLike['oneoff_benefits']][] = [
    ['oneoff', snapshot.oneoff_benefits ?? []],
    ['session', snapshot.session_benefits ?? []],
    ['periodical', snapshot.periodical_benefits ?? []],
  ];
  const out: UnitAssigneeLine[] = [];
  for (const [section, rows] of sections) {
    for (const r of rows) {
      if (!r.unit_assignees || r.unit_assignees.length === 0) continue;
      out.push({
        section, product_id: r.product_id, item_name: r.item_name,
        assignees: r.unit_assignees.map((m) => m.member_id),
        names: r.unit_assignees.map((m) => m.name),
      });
    }
  }
  return out;
}

/** A line's key, for a draft map and a React key. */
export const unitLineKey = (l: Pick<UnitAssigneeLine, 'section' | 'product_id'>) => `${l.section}:${l.product_id}`;

/** The section is worth showing only when there is a line and more than one person to give it to. */
export function showsUnitAssignees(lines: UnitAssigneeLine[], eligibleCount: number): boolean {
  return lines.length > 0 && eligibleCount > 1;
}

/** The lines whose draft differs from what the server reported — the only ones a Save sends. */
export function changedUnitLines(lines: UnitAssigneeLine[], draft: Record<string, number[]>): UnitAssigneeLine[] {
  return lines
    .filter((l) => {
      const d = draft[unitLineKey(l)];
      return d != null && (d.length !== l.assignees.length || d.some((id, i) => id !== l.assignees[i]));
    })
    .map((l) => ({ ...l, assignees: draft[unitLineKey(l)] }));
}
