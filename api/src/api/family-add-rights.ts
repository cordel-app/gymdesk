import { db, Tx } from '../infra/db';
import { familyOwnerOnlyBody, familyOwnerOnlyPaymentsBody, mayAddPlansAndProducts, mayViewPayments } from '../domain/familyAddRights';
import { loadFamilyOwnerId } from './payer-resolution';

type Q = Pick<Tx, 'query'> | typeof db;

/** #2770: whether this Member may add a Membership Plan or a Product (the Family Owner, or a Member with no family). */
export async function memberMayAddPlansAndProducts(q: Q, gymId: string, memberId: number): Promise<boolean> {
  return mayAddPlansAndProducts(memberId, await loadFamilyOwnerId(q, gymId, memberId));
}

/**
 * #2770: answers `403 family_owner_only` and returns `true` when the Member may
 * not add; the caller then stops. Every Members App route that adds a Plan or a
 * Product calls it, so hiding the buttons is never the only enforcement.
 */
export async function refuseUnlessMayAdd(res: any, gymId: string, memberId: number): Promise<boolean> {
  if (await memberMayAddPlansAndProducts(db, gymId, memberId)) return false;
  res.status(403).json(familyOwnerOnlyBody());
  return true;
}

/** #2776: whether this Member may see the Payments tab (the Family Owner, or a Member with no family). */
export async function memberMayViewPayments(q: Q, gymId: string, memberId: number): Promise<boolean> {
  return mayViewPayments(memberId, await loadFamilyOwnerId(q, gymId, memberId));
}

/**
 * #2776: answers `403 family_owner_only` and returns `true` when the Member may
 * not see Payments; called by the two reads the Payments tab draws from
 * (`GET /me/billing-events`, `GET /me/billing-event-forecast`), so hiding the
 * tab is never the only enforcement.
 */
export async function refuseUnlessMayViewPayments(res: any, gymId: string, memberId: number): Promise<boolean> {
  if (await memberMayViewPayments(db, gymId, memberId)) return false;
  res.status(403).json(familyOwnerOnlyPaymentsBody());
  return true;
}
