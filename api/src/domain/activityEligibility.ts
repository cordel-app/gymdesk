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
 * `packageBacked` is the one answer that is about *stage 3* rather than this
 * stage: when every matching balance comes from a purchased class package,
 * the booking is paid out of one exactly as it was before this ticket
 * (`tryClaimPackageCredit()`), because consumption — `Q2`: a session is spent
 * on attendance, on a late cancellation or on a no-show, never on booking —
 * is stage 3's ledger, and until it exists a package that nothing ever debits
 * would be an unlimited one. A balance a Plan or a Promotion grants charges
 * nothing, which is the pre-ticket rule for a plan that already covers the
 * activity.
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
  /** `true` when the member is eligible only through purchased class packages. */
  packageBacked: boolean;
}

/** The booking refusal's machine-readable code. */
export const PROFESSIONAL_SERVICE_REQUIRED_CODE = 'professional_service_required';

export function decideServiceEligibility(
  required: RequiredProfessionalService[],
  memberServices: MemberProfessionalService[],
): ServiceEligibility {
  if (required.length === 0) {
    return { eligible: true, required, matched: [], packageBacked: false };
  }
  const requiredIds = new Set(required.map((s) => s.id));
  const matched = memberServices.filter(
    (s) => requiredIds.has(s.professional_service_id) && s.sessions > 0,
  );
  const packageBacked =
    matched.length > 0
    && matched.every((s) => s.sources.every((src) => src.kind === 'class_package'));
  return { eligible: matched.length > 0, required, matched, packageBacked };
}
