# `user_memberships` dependency inventory (#1582, stage 1)

The audit stage 2–6 of #1582 work from. `user_memberships` is today the
**projection** of the Active ProductSet (`projectActiveProductSet()`); the
ProductSet owns the configuration (CLAUDE.md, #1325). Generated with
`grep -c user_memberships` per production source under `api/src` (SQL mentions,
reads and writes together); each file is assigned to the stage that migrates it.

Canonical resolution (stage 1): `api/src/domain/currentProductSet.ts` —
in-flight version, else the single `active` one; `ambiguous` is an explicit
state; plan status comes from the snapshot, ProductSet status from
`product_sets`, never synchronised.

| Stage | Scope | Files (mentions) |
|---|---|---|
| 2 reads | heuristic grouping, confirm in the stage | `api/card-updates.ts` (2), `api/financials-dashboard.ts` (1), `api/home-dashboard.ts` (4), `api/me.ts` (8), `api/member-membership-configuration.ts` (3), `api/membership-fee-pricing.ts` (2), `api/membership-promotions.ts` (4), `api/nutrition-dashboard.ts` (1), `api/one-active-plan.ts` (4), `api/plan-center-access.ts` (1), `api/plan-class-types.ts` (6), `api/product-sets.ts` (2), `domain/auditActor.ts` (1), `domain/auditInventory.ts` (4), `domain/devBillingReset.ts` (1), `domain/memberEnrollment.ts` (2), `domain/memberProductPurchase.ts` (1), `domain/memberProfessionalServices.ts` (3), `domain/nutritionLibrary.ts` (1), `domain/oneActivePlan.ts` (2), `domain/personalFeeBenefit.ts` (1), `domain/planDuration.ts` (1), `infra/audit-registry.ts` (1), `scripts/report-multi-active-memberships.ts` (4) |
| 3 eligibility | heuristic grouping, confirm in the stage | `api/member-professional-services.ts` (1), `api/new-member-eligibility.ts` (3), `api/plan-allowance-renewals.ts` (1), `api/user-membership-services.ts` (3) |
| 4 billing | heuristic grouping, confirm in the stage | `api/billing-events.ts` (1), `api/billing-simulation.ts` (1), `api/derived-billing.ts` (1), `api/me-billing-forecast.ts` (3), `api/payment-page.ts` (1), `api/payment-requests.ts` (1), `api/payments.ts` (5), `api/scheduled-event-execution.ts` (3), `domain/billingEventOwnership.ts` (2), `domain/billingEventPayments.ts` (3), `domain/derivedBilling.ts` (1), `payments/money.ts` (1) |
| 5 writers | heuristic grouping, confirm in the stage | `api/assigned-plan-snapshot.ts` (4), `api/assignment-commit.ts` (4), `api/assignment-config.ts` (3), `api/assignment-draft-set.ts` (1), `api/me-membership-plans.ts` (1), `api/membership-plans.ts` (6), `api/product-set-bridge.ts` (1), `api/product-set-projection.ts` (7), `api/user-memberships.ts` (29), `domain/assignedPlanBillingEvents.ts` (1), `domain/assignmentRelationship.ts` (2) |

Stage 6 also removes the `user_membership_members` view (coverage is the
chain's `product_set_members`), the test helpers `legacyAssignmentQuery()` /
`legacyChildQuery()` and the fixtures that insert `user_memberships` rows.

Open items for later stages: the Stage column above is a first-cut heuristic;
each stage re-reads its files for read/write/relies-on-existence before moving.
