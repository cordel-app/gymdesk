// #1075 (Q1 ticket) — a member is linked by the **invitation**, not by the
// address the sign-in happens to report.
//
// `POST /members/:id/invite` and `/reinvite` stamp the Clerk invitation with
// `publicMetadata.member_invite = { gym_id, member_id }`, which Clerk copies onto
// the user who signs up through that ticket. Public metadata is server-set only,
// so — like #599's `gym_signup` — it proves our backend invited *this* member to
// *this* gym. A member who signs in with Apple's Hide My Email arrives as
// `…@privaterelay.appleid.com`, which equals no invited address; the metadata is
// what still names their row.
//
// The email match stays as the fallback (every invitation issued before this
// ticket carries no metadata), so this module only answers "does the user name a
// member of this gym", never "is there a match".
//
// Pure — no DB, no HTTP.

export interface MemberInviteMetadata {
  gym_id: string;
  member_id: number;
}

/** The member the invitation was issued for, or null when it names none for this gym. */
export function memberInviteTarget(publicMetadata: unknown, gymId: string): number | null {
  const raw = (publicMetadata as { member_invite?: unknown } | null | undefined)?.member_invite;
  if (!raw || typeof raw !== 'object') return null;
  const { gym_id, member_id } = raw as { gym_id?: unknown; member_id?: unknown };
  if (String(gym_id) !== String(gymId)) return null;
  const id = Number(member_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function memberInviteMetadata(gymId: string, memberId: number | string) {
  return { member_invite: { gym_id: String(gymId), member_id: Number(memberId) } };
}
