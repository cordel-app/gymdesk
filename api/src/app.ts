import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { verifyToken } from '@clerk/backend';
import { Request, Response, NextFunction } from 'express';
import { membersRouter } from './api/members';
import { bookingsRouter } from './api/bookings';
import { userMembershipsRouter } from './api/user-memberships';
import { gymsRouter, platformRouter } from './api/gyms';
import { storageRouter } from './api/storage';
import { superadminsRouter } from './api/superadmins';
import { impersonationRouter } from './api/impersonation';
import { membershipPlansRouter } from './api/membership-plans';
import { benefitTypesRouter } from './api/benefit-types';
import { financialsDashboardRouter } from './api/financials-dashboard';
import { chargeTypesRouter } from './api/charge-types';
import { billingEventsRouter } from './api/billing-events';
import { spacesRouter } from './api/spaces';
import { trainersRouter } from './api/trainers';
import { activityTypesRouter } from './api/activity-types';
import { activityTypeScheduleRulesRouter } from './api/activity-type-schedule-rules';
import { professionalServicesRouter } from './api/professional-services';
import { memberProfessionalServicesRouter } from './api/member-professional-services';
import { memberPersonalTrainingSlotsRouter } from './api/member-personal-training-slots';
import { classSessionsRouter } from './api/calendar-events';
// Side-effect import: registers the booking access hook for activity-type eligibility
// (public_event / activity_type_eligible_plans). Must be imported BEFORE plan-allowances
// so an ineligible member is rejected before entitlement is even evaluated (#481).
import './api/activity-eligibility';
// Side-effect import: registers the booking access hook for plan allowances + center validation.
import './api/plan-allowances';
import { classPackagesRouter } from './api/class-packages';
import { userClassPackagesRouter } from './api/user-class-packages';
import { actionTypesRouter } from './api/action-types';
import { sellableItemsRouter } from './api/sellable-items';
import { taxesRouter } from './api/taxes';
import { promotionsRouter } from './api/promotions';
import { promotionDetailsRouter } from './api/promotion-details';
import { membershipPromotionsRouter } from './api/membership-promotions';
import { memberBillingSimulationRouter } from './api/billing-simulation';
import { memberMembershipConfigurationRouter } from './api/member-membership-configuration';
import { userMembershipServicesRouter } from './api/user-membership-services';
import { musclesRouter, exercisesRouter } from './api/exercises';
import { resultTypesRouter } from './api/result-types';
import { workoutTemplatesRouter } from './api/workout-templates';
import { trainingPlanTemplatesRouter } from './api/training-plan-templates';
import { trainingPlansRouter } from './api/training-plans';
import { gymTrainingPlansRouter } from './api/gym-training-plans';
import { memberTrainingPlansRouter } from './api/member-training-plans';
import { exerciseLogsRouter, workoutBlockLogsRouter } from './api/exercise-logs';
import { auditLogsRouter } from './api/audit-logs';
import { centersRouter } from './api/centers';
import { memberCentersRouter } from './api/member-centers';
import { trainerAvailabilityRouter } from './api/trainer-availability';
import { operatingHoursRouter } from './api/operating-hours';
// Side-effect import: registers the booking access hook for package credits.
// Must be imported BEFORE plan-allowances so its hook is queued first
// (plan-access checks getPackageIntent to know whether to bail on 403).
import './api/package-credits';
import { publicRouter } from './api/public';
import { meRouter, meLinkRouter, meGymRouter, meGymsRouter } from './api/me';
import { themesRouter, themesPublicRouter } from './api/themes';
import { gymThemesRouter } from './api/gym-themes';
import { staffRouter, staffLinkRouter } from './api/staff';
import { staffCentersRouter } from './api/staff-centers';
import { paymentsRouter } from './api/payments';
import { paymentsDashboardRouter } from './api/payments-dashboard';
import { nutritionPlanTemplatesRouter } from './api/nutrition-plan-templates';
import { nutritionLibraryRouter } from './api/nutrition-library';
import { platformNutritionLibraryRouter } from './api/platform-nutrition-library';
import { platformNutritionPlanTemplatesRouter } from './api/platform-nutrition-plan-templates';
import { platformExercisesRouter } from './api/platform-exercises';
import { platformWorkoutTemplatesRouter } from './api/platform-workout-templates';
import { platformTrainingPlanTemplatesRouter } from './api/platform-training-plan-templates';
import { memberNutritionPlansRouter } from './api/member-nutrition-plans';
import { calendarEventsRouter } from './api/calendar-events';
import { sharedTrainingRequestsRouter } from './api/shared-training-requests';
import { recycleBinRouter } from './api/recycle-bin';
import { platformFeatureFlagsRouter, featureFlagsPublicRouter } from './api/platform-feature-flags';
import { paymentProvidersRouter } from './api/payment-providers';
import { requireFeatureEnabled } from './infra/featureFlags';
import { clerkWebhookRouter, paymentWebhookRouter } from './api/webhooks';
import { paymentRequestsRouter } from './api/payment-requests';
import { paymentPageRouter } from './api/payment-page';
import { billingRouter } from './api/billing';
import { recurringBookingsRouter } from './api/recurring-bookings';
import { tenantContext, requireModuleAccess } from './infra/tenantContext';
import { centerContext } from './infra/centerContext';
import { publicRegistrationsRouter } from './api/public-registrations';
import { websiteIntegrationRouter } from './api/website-integration';
import { swaggerSpec } from './infra/swagger';
import { requestLogger } from './middleware/requestLogger';

export const app = express();

// #599: the API runs behind nginx (infra/nginx/corback.conf). Without this,
// req.ip is the proxy's address for every request, so every per-IP rate limiter
// collapses into a single bucket shared by all clients.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

app.use(requestLogger);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use(apiLimiter as any);

// Clerk webhooks must be mounted BEFORE express.json(): signature verification
// needs the exact raw request bytes, so this route parses its own raw body.
app.use('/webhooks/clerk', express.raw({ type: 'application/json' }), clerkWebhookRouter);

// Payment webhooks must also precede express.json() for the same reason.
// express.raw({ type: '*/*' }) captures any content-type Monei may use.
app.use('/webhooks/payment', express.raw({ type: '*/*' }), paymentWebhookRouter);

app.use(express.json());

function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
      (req as any).auth = { userId: payload.sub };
      next();
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/docs', swaggerUi.serve as any);
app.get('/docs', swaggerUi.setup(swaggerSpec, { customSiteTitle: 'Gymdesk API' }) as any);

// Public endpoints — no auth, no tenant context (identified by gym id or slug)
// #599: website self-registration — per-gym API key, not a Clerk session.
// #645: :gymRef is `{gymId}-{gym-name}` (a bare slug is still accepted).
app.use('/public/gyms/:gymRef/registrations', publicRegistrationsRouter);
app.use('/public', publicRouter);

// Payment page — no Clerk auth; authenticated by single-use page_token
app.use('/payment-page', paymentPageRouter);

// Internal billing runner — authenticated by X-Internal-Secret header
app.use('/billing', billingRouter);

// #647 stage 4: internal nightly runner that maintains the rolling 2-month
// Personal Training booking window — same X-Internal-Secret pattern as /billing.
app.use('/recurring-bookings', recurringBookingsRouter);

// Theme logo — no auth (img tags in both apps need this)
app.use('/themes', themesPublicRouter);

// Gym listing/membership — auth required but no tenant context (gymId not known yet)
app.use('/gyms', requireAuth(), gymsRouter);

// Platform superadmin routes
app.use('/platform/themes', requireAuth(), themesRouter);
app.use('/platform/nutrition-library', requireAuth(), platformNutritionLibraryRouter);
app.use('/platform/nutrition-plan-templates', requireAuth(), platformNutritionPlanTemplatesRouter);
app.use('/platform/exercises', requireAuth(), platformExercisesRouter);
app.use('/platform/workout-templates', requireAuth(), platformWorkoutTemplatesRouter);
app.use('/platform/training-plan-templates', requireAuth(), platformTrainingPlanTemplatesRouter);
app.use('/platform', requireAuth(), platformRouter);
app.use('/platform/superadmins', requireAuth(), superadminsRouter);
app.use('/platform/impersonation', requireAuth(), impersonationRouter);
app.use('/platform/feature-flags', requireAuth(), platformFeatureFlagsRouter);
// #636: Payment Providers are Cordel-level configuration — no tenantContext,
// guarded per-route by requireSuperadmin, like the other platform catalogues.
app.use('/platform/payment-providers', requireAuth(), paymentProvidersRouter);

// Feature flags public read — any authenticated user (used by frontend sidebar)
app.use('/feature-flags', requireAuth(), featureFlagsPublicRouter);

// Domain routes — require auth + tenant context (gym_id from x-gym-id header)
// /me/link + /staff/link must come before tenantContext (no membership row exists yet on first link)
app.use('/me/link', requireAuth(), meLinkRouter);
app.use('/staff/link', requireAuth(), staffLinkRouter);
// /me/gym and /me/gyms must come BEFORE /me to avoid being swallowed by tenantContext
app.use('/me/gym',  requireAuth(), meGymRouter);
app.use('/me/gyms', requireAuth(), meGymsRouter);
app.use('/me',      requireAuth(), tenantContext, centerContext, meRouter);

// ORGANIZATION module — admin=RW, trainer*/front_desk/nutritionist=R, accountant/member=NONE
app.use('/spaces',        requireAuth(), tenantContext, centerContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.spaces'), spacesRouter);
app.use('/trainers',      requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.staff'), trainersRouter);
app.use('/staff',         requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.staff'), staffRouter);
app.use('/staff/:staffId/centers', requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.staff'), staffCentersRouter);
app.use('/activity-types', requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.activity_types'), activityTypesRouter);
app.use('/activity-types/:activityTypeId/schedule-rules', requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.activity_types'), activityTypeScheduleRulesRouter);
app.use('/professional-services', requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.professional_services'), professionalServicesRouter);
app.use('/class-packages', requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.class_packages'), classPackagesRouter);
app.use('/centers',       requireAuth(), tenantContext, centerContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.centers'), centersRouter);
app.use('/trainer-availability', requireAuth(), tenantContext, centerContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('organization.staff'), trainerAvailabilityRouter);
app.use('/operating-hours', requireAuth(), tenantContext, requireModuleAccess('ORGANIZATION'), requireFeatureEnabled('calendar.operating_hours'), operatingHoursRouter);

// MEMBERS module — admin/front_desk=RW, trainer*/nutritionist=R_ASSIGNED, accountant/member=NONE
app.use('/members',       requireAuth(), tenantContext, requireModuleAccess('MEMBERS'), requireFeatureEnabled('membership.members'), membersRouter);
app.use('/members/:memberId/centers', requireAuth(), tenantContext, centerContext, requireModuleAccess('MEMBERS'), requireFeatureEnabled('membership.members'), memberCentersRouter);
// #647 stage 1: the Member side of the Professional Service link. Gated on the
// MEMBERS module (it reads one Member's entitlements) but on the Professional
// Services feature flag, since it has nothing to return when that is off.
app.use('/members/:memberId/professional-services', requireAuth(), tenantContext, requireModuleAccess('MEMBERS'), requireFeatureEnabled('organization.professional_services'), memberProfessionalServicesRouter);
// #647 stage 2: the weekly Personal Training availability projection. Same
// gating as stage 1 — it is a read of one Member's slots, and it has nothing
// to project when Professional Services are switched off.
app.use('/members/:memberId/personal-training-slots', requireAuth(), tenantContext, requireModuleAccess('MEMBERS'), requireFeatureEnabled('organization.professional_services'), memberPersonalTrainingSlotsRouter);
app.use('/bookings',       requireAuth(), tenantContext, centerContext, requireModuleAccess('MEMBERS'), requireFeatureEnabled('calendar.calendar'), bookingsRouter);

// TRAINING module — admin/trainer_performance/trainer_perf_nutrition=RW, front_desk/nutritionist(ASSIGNED)=R, accountant/member=NONE
app.use('/storage',          requireAuth(), tenantContext, storageRouter);
app.use('/muscles',          requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.exercises'), musclesRouter);
app.use('/exercises',        requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.exercises'), exercisesRouter);
app.use('/result-types',     requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.exercises'), resultTypesRouter);
app.use('/workout-templates', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.workout_templates'), workoutTemplatesRouter);
app.use('/training-plan-templates', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.training_plan_templates'), trainingPlanTemplatesRouter);
app.use('/training-plans',   requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.training_plans'), gymTrainingPlansRouter);
app.use('/members/:memberId/training-plans', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.training_plans'), trainingPlansRouter);
app.use('/members/:memberId/member-training-plans', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training.training_plans'), memberTrainingPlansRouter);
app.use('/members/:memberId/exercise-logs', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training'), exerciseLogsRouter);
app.use('/members/:memberId/workout-block-logs', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('training'), workoutBlockLogsRouter);
// #614: Calendar is its own permission module (#247) — front desk can create/edit events.
app.use('/class-sessions',         requireAuth(), tenantContext, centerContext, requireModuleAccess('CALENDAR'), requireFeatureEnabled('calendar.calendar'), classSessionsRouter);
app.use('/calendar-events',        requireAuth(), tenantContext, requireModuleAccess('CALENDAR'), requireFeatureEnabled('calendar.calendar'), calendarEventsRouter);
app.use('/shared-training-requests', requireAuth(), tenantContext, requireModuleAccess('TRAINING'), requireFeatureEnabled('calendar.member_calendar'), sharedTrainingRequestsRouter);

// NUTRITION module — admin=RW, trainer_perf_nutrition/nutritionist=RW_ASSIGNED, trainer_performance=R_ASSIGNED, front_desk=R, accountant/member=NONE
app.use('/nutrition-plan-templates', requireAuth(), tenantContext, requireModuleAccess('NUTRITION'), requireFeatureEnabled('nutrition.nutrition_plan_templates'), nutritionPlanTemplatesRouter);
app.use('/member-nutrition-plans', requireAuth(), tenantContext, requireModuleAccess('NUTRITION'), requireFeatureEnabled('nutrition.nutrition_plans'), memberNutritionPlansRouter);
// Global read-only catalog — no gym_id required; only requireAuth + module gate
app.use('/nutrition-library', requireAuth(), tenantContext, requireModuleAccess('NUTRITION'), requireFeatureEnabled('nutrition.nutrition_library'), nutritionLibraryRouter);

// FINANCIALS module — admin=RW, front_desk/accountant=R, trainer*/nutritionist/member=NONE
app.use('/membership-plans', requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.plans'), membershipPlansRouter);
// #638: Finance → Dashboard. Read-only aggregation; gated on the Financials
// group flag so it survives the Plans page being turned off.
app.use('/financials/dashboard', requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), financialsDashboardRouter);
app.use('/benefit-types',    requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), benefitTypesRouter);
app.use('/charge-types',     requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), chargeTypesRouter);
app.use('/action-types',     requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), actionTypesRouter);
app.use('/sellable-items',   requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.gym_charges'), sellableItemsRouter); // lgtm[js/missing-rate-limiting]
// Reads depend only on the Financials group flag: Plans and Sellable Items load /taxes for
// their tax dropdown. The Taxes page's own flag (financials.taxes) gates writes in the router (#610).
app.use('/taxes',            requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), taxesRouter); // lgtm[js/missing-rate-limiting]
app.use('/promotions',       requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.promotions'), promotionsRouter);
app.use('/promotions/:id',   requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.promotions'), promotionDetailsRouter);

// PAYMENTS module — admin/front_desk=RW, accountant=R, member=R_OWN (via /me/*), trainer*/nutritionist=NONE
app.use('/billing-events',   requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), billingEventsRouter);
app.use('/user-memberships', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), userMembershipsRouter);
app.use('/user-memberships/:id/promotions', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), membershipPromotionsRouter);
// #631: Additional Periodic Services attached to one Assigned Plan. Three path
// segments, so userMembershipsRouter's own '/:id' (one segment) never matches.
app.use('/user-memberships/:id/services', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), userMembershipServicesRouter);
// #629: three path segments, so userMembershipsRouter (mounted above) never
// matches it and the request falls through to here.
app.use('/user-memberships/member/:memberId/billing-simulation', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), memberBillingSimulationRouter);
// #634: the Member's Membership Plans / Promotions / Additional Services in one
// read — the three configuration sections that sit above the simulation.
app.use('/user-memberships/member/:memberId/configuration', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), memberMembershipConfigurationRouter);
app.use('/members/:memberId/class-packages', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('organization.class_packages'), userClassPackagesRouter);
// #674: mounted before `/payments` so the Dashboard is gated by its own flag —
// `/payments` would otherwise match `/payments/dashboard/*` first and 403 it
// whenever Transactions is switched off.
app.use('/payments/dashboard', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.dashboard'), paymentsDashboardRouter);
app.use('/payments',          requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), paymentsRouter);
app.use('/payment-requests',  requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), paymentRequestsRouter);

// SYSTEM module — admin=RW, all others=NONE
app.use('/audit-logs',       requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.audit'), auditLogsRouter);
app.use('/system/themes',    requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.themes'), gymThemesRouter);
app.use('/system/website-integration', requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.website_integration'), websiteIntegrationRouter);
app.use('/recycle-bin',      requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.recycle_bin'), recycleBinRouter);

// Global error handler — must be last, after all routes
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({ error: err?.message || 'Internal server error' });
});
