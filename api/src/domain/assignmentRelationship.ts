/**
 * #1191 — how an Assigned Plan relates to the Member whose context it is shown
 * in. A multi-member Membership (a Duo) is ONE `user_memberships` row: its
 * `member_id` is the owner and `user_membership_members` lists every covered
 * Member. Seen from the owner it is `primary`; seen from any other covered
 * Member it is `linked`.
 *
 * It is **derived, never stored** — a `linked` column could only drift from the
 * two tables it summarises — and this module is the one place that decides it,
 * together with the one SQL fragment for "the Memberships of Member X" so a
 * list, the configuration read and the guard cannot disagree about who is
 * covered (the #956 Q4 reading of coverage, applied to reads).
 */

export const ASSIGNMENT_RELATIONSHIPS = ['primary', 'linked'] as const;
export type AssignmentRelationship = (typeof ASSIGNMENT_RELATIONSHIPS)[number];

/** `primary` when the viewed Member owns the Membership, otherwise `linked`. */
export function assignmentRelationship(
  viewedMemberId: number | string,
  ownerMemberId: number | string,
): AssignmentRelationship {
  return Number(viewedMemberId) === Number(ownerMemberId) ? 'primary' : 'linked';
}

/**
 * `um` is the `user_memberships` alias. Binds the Member id **twice** (owner
 * column, then covered-member row). The owner's own column is read as well as
 * the join table because a row written before #374 may carry no
 * `user_membership_members` row.
 */
export const MEMBER_MEMBERSHIP_SQL = `(um.member_id = ? OR EXISTS (
    SELECT 1 FROM user_membership_members umm
    WHERE umm.user_membership_id = um.id AND umm.gym_id = um.gym_id AND umm.member_id = ?))`;

/** Whether a Linked context may perform a Membership-level write: it may not. */
export const LINKED_READ_ONLY_ERROR = 'linked_member_read_only';
