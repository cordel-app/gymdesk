import type { MemberProfessionalService } from './memberProfessionalServices';

/**
 * #973 stage 1: may this Member book this Activity Type?
 *
 * The rule, as the issue thread settled it:
 *
 *   - An activity names the **Professional Services** that may book it
 *     (`activity_type_eligible_professional_services`, migration 231). There
 *     is no Membership Plan relation any more — `Q1 wallet`: a member reaches
 *     a service through the sessions they hold for it, from whichever Product
 *     granted them (`domain/memberProfessionalServices.ts`).
 *   - An activity that names **no** service is open to every member
 *     (`Q3 open`). That is also what makes migration 231 safe to deploy: the
 *     old Plan rows are not mapped, so every activity starts open.
 *   - Otherwise the member needs a **balance above zero** on at least one of
 *     the named services. `aggregateProfessionalServiceGrants()` already
 *     drops non-positive counts, so "the member's services" and "the services
 *     the member has sessions for" are the same list.
 *
 * Pure, so the booking gate and `GET /members/:id/personal-training-slots`
 * (which asks the same question per Activity Type) are provably the same
 * rule; the SQL that feeds it lives in `api/activity-eligibility.ts`.
 *
 * Booking spends nothing (`Q2`): a session is spent on attendance, a late
 * cancellation or a no-show, by the consumption ledger (#1189 stage 3).
 */

export interface RequiredProfessionalService {
  id: number;
  name: string;
}

export interface ServiceEligibility {
  /** `true` when the activity names no service, or the member holds a balance on one it names. */
  eligible: boolean;
  /** The services the activity names, so a refusal can say what would unlock it. */
  required: RequiredProfessionalService[];
  /** The member's services (balance > 0) that are among the required ones. */
  matched: MemberProfessionalService[];
}

/** The booking refusal's machine-readable code. */
export const PROFESSIONAL_SERVICE_REQUIRED_CODE = 'professional_service_required';

export function decideServiceEligibility(
  required: RequiredProfessionalService[],
  memberServices: MemberProfessionalService[],
): ServiceEligibility {
  if (required.length === 0) {
    return { eligible: true, required, matched: [] };
  }
  const requiredIds = new Set(required.map((s) => s.id));
  const matched = memberServices.filter(
    (s) => requiredIds.has(s.professional_service_id) && s.sessions > 0,
  );
  return { eligible: matched.length > 0, required, matched };
}
