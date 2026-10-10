import 'dotenv/config';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { verifyToken } from '@clerk/backend';
import { Request, Response, NextFunction } from 'express';
import { membersRouter } from './api/members';
import { bookingsRouter } from './api/bookings';
import { userMembershipsRouter } from './api/user-memberships';
import { productSetsRouter, meProductSetsRouter } from './api/product-sets-router';
import { gymsRouter, platformRouter } from './api/gyms';
import { storageRouter } from './api/storage';
import { superadminsRouter } from './api/superadmins';
import { orphanedAccountsRouter } from './api/orphaned-accounts';
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
// (public_event / activity_type_eligible_professional_services, #973 stage 1 — there is
// no plan-based gate any more), which also claims a class-package credit when the
// member qualifies through a purchased package alone.
import './api/activity-eligibility';
// Side-effect import: registers the booking access hook for plan center coverage.
import './api/plan-center-access';
import { classPackagesRouter } from './api/class-packages';
import { userClassPackagesRouter } from './api/user-class-packages';
import { actionTypesRouter } from './api/action-types';
import { productsRouter } from './api/products';
import { taxesRouter } from './api/taxes';
import { promotionsRouter } from './api/promotions';
import { promotionDetailsRouter } from './api/promotion-details';
import { membershipPromotionsRouter } from './api/membership-promotions';
import { memberBillingSimulationRouter } from './api/billing-simulation';
import { memberMembershipConfigurationRouter } from './api/member-membership-configuration';
import { userMembershipServicesRouter } from './api/user-membership-services';
import {
  EXERCISE_IMAGE_UPLOAD_PATH, EXERCISE_VIDEO_UPLOAD_PATH,
  exerciseImageBodyParser, exerciseVideoBodyParser, exercisesRouter, musclesRouter,
} from './api/exercises';
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
// #947: the Nutrition Library's two goal catalogues. One factory per side serves
// both kinds — `api/src/domain/goalLibrary.ts` is what decides they are the same
// shape — so each is mounted twice rather than written twice.
import { nutritionGoalsRouter, personalGoalsRouter } from './api/goal-library';
import { platformNutritionGoalsRouter, platformPersonalGoalsRouter } from './api/platform-goal-library';
import { platformNutritionPlanTemplatesRouter } from './api/platform-nutrition-plan-templates';
import {
  PLATFORM_EXERCISE_IMAGE_UPLOAD_PATH, PLATFORM_EXERCISE_VIDEO_UPLOAD_PATH,
  platformExerciseImageBodyParser, platformExerciseVideoBodyParser, platformExercisesRouter,
} from './api/platform-exercises';
import { platformWorkoutTemplatesRouter } from './api/platform-workout-templates';
import { platformTrainingPlanTemplatesRouter } from './api/platform-training-plan-templates';
import { memberNutritionPlansRouter } from './api/member-nutrition-plans';
// #948 §4: the Personal Goals a member actually holds. The catalogue says which
// goals exist; this says who holds which.
import { memberPersonalGoalsRouter } from './api/member-personal-goals';
import { mePersonalGoalsRouter } from './api/me-personal-goals';
import { meProfileImageRouter } from './api/me-profile-image';
import { meMembershipPlansRouter } from './api/me-membership-plans';
import { nutritionDashboardRouter } from './api/nutrition-dashboard';
import { calendarEventsRouter } from './api/calendar-events';
import { sharedTrainingRequestsRouter } from './api/shared-training-requests';
import { recycleBinRouter } from './api/recycle-bin';
import { platformFeatureFlagsRouter, featureFlagsPublicRouter } from './api/platform-feature-flags';
import { platformMobileBuildsRouter } from './api/platform-mobile-builds';
import { paymentProvidersRouter } from './api/payment-providers';
import { requireFeatureEnabled } from './infra/featureFlags';
import { clerkWebhookRouter, paymentWebhookRouter } from './api/webhooks';
import { paymentRequestsRouter } from './api/payment-requests';
import { paymentMethodsRouter } from './api/payment-methods';
import { paymentPageRouter } from './api/payment-page';
import { billingRouter } from './api/billing';
import { recurringBookingsRouter } from './api/recurring-bookings';
import { promotionLifecycleRouter } from './api/promotion-lifecycle';
import { planAllowanceRenewalsRouter } from './api/plan-allowance-renewals';
import { bookingRemindersRouter } from './api/booking-reminders';
import { healthRouter } from './api/health';
import { tenantContext, requireFeatureAccess, requireModuleAccess } from './infra/tenantContext';
import { centerContext } from './infra/centerContext';
import { publicRegistrationsRouter } from './api/public-registrations';
import { websiteIntegrationRouter } from './api/website-integration';
import { gymLocalizationRouter } from './api/gym-localization';
import { swaggerSpec } from './infra/swagger';
import { requestLogger } from './middleware/requestLogger';
import { internalRunRateLimitConfig, spendsInternalRunBudget } from './domain/internalRunRateLimit';
import { API_RATE_LIMIT_WINDOW_MS, apiRateLimitKey, apiRateLimitMax } from './domain/apiRateLimit';
import { internalRunClientKey, trustProxyHops } from './domain/forwardedClient';
import { httpErrorStatus, publicErrorMessage } from './domain/httpErrorResponse';

export const app = express();

// #599: the API runs behind a reverse proxy (Traefik on corfront). Without this,
// req.ip is the proxy's address for every request, so every per-IP rate limiter
// collapses into a single bucket shared by all clients. The count is read in one
// place (domain/forwardedClient.ts), because since #1083 one route sits behind
// one more hop than the rest and has to add to this number rather than replace it.
app.set('trust proxy', trustProxyHops());

app.use(requestLogger);

// #1395: keyed on the signed-in person, not on the address. Both Next apps'
// `/api/proxy` routes forward no `X-Forwarded-For`, so by address every member
// is the Members App container and every staff user the admin container, and
// one person spending the budget locked everyone else out. See
// domain/apiRateLimit.ts for why the token is read unverified and why this is
// not a `trust proxy` change.
const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  limit: apiRateLimitMax(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => apiRateLimitKey(req.headers.authorization, ipKeyGenerator(req.ip ?? '')),
});
app.use(apiLimiter as any);

// #783: the internal run routes are authenticated by X-Internal-Secret alone —
// no nginx allowlist sits in front of them any more — so they get a budget of
// their own, far below the global one, that only a failed secret (401) spends.
// Since #1086 those routes are reached through the admin app's `/api/internal`
// relay, which changes the key below and nothing else: the secret is still
// compared here, by each router's own `checkInternalSecret()`.
// See domain/internalRunRateLimit.ts for why a caller holding the secret, and
// #781's two daily attempts with it, never consume it.
const internalRunRateLimit = internalRunRateLimitConfig();
const internalRunLimiter = rateLimit({
  windowMs: internalRunRateLimit.windowMs,
  limit: internalRunRateLimit.limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => !spendsInternalRunBudget(res.statusCode),
  // #1086: the key is the client address, not the request's peer. The nightly
  // workflows post to the admin app's `/api/internal` relay, which forwards the
  // `X-Forwarded-For` it was called with, so the chain in front of these four
  // routes is one hop longer than `trust proxy` accounts for. Keyed on the
  // relay, ten wrong-secret guesses from anywhere would answer the billing run
  // `429` for the rest of the window — see domain/forwardedClient.ts for why the
  // extra hop is declared per route and defaults to none (where this is
  // `req.ip`, exactly as before).
  keyGenerator: (req) => {
    const client = internalRunClientKey({
      ip: req.ip,
      socketAddress: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
    });
    return client === '' ? '' : ipKeyGenerator(client);
  },
});

// Clerk webhooks must be mounted BEFORE express.json(): signature verification
// needs the exact raw request bytes, so this route parses its own raw body.
app.use('/webhooks/clerk', express.raw({ type: 'application/json' }), clerkWebhookRouter);

// Payment webhooks must also precede express.json() for the same reason.
// express.raw({ type: '*/*' }) captures any content-type Monei may use.
app.use('/webhooks/payment', express.raw({ type: '*/*' }), paymentWebhookRouter);

// #719: a Gym Exercise image upload carries two PNGs (a 2048×2048 master and
// its 512×512 thumbnail) as base64 in one JSON body — the two must succeed or
// fail together — so it is parsed here, with its own limit, before the global
// parser's 100 kB default would reject it as a bare 413. #716 gives a Base
// Exercise the same pair on the platform router, with the same reasoning.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (EXERCISE_IMAGE_UPLOAD_PATH.test(req.path)) return exerciseImageBodyParser(req, res, next);
  if (PLATFORM_EXERCISE_IMAGE_UPLOAD_PATH.test(req.path)) return platformExerciseImageBodyParser(req, res, next);
  return next();
});

// #719 part 2: the same for a video upload — an MP4 and its 512×512 poster in
// one JSON body, with a limit of its own (EXERCISE_VIDEO_MAX_MB) because an MP4
// is orders of magnitude larger than a PNG pair. #717 gives a Base Exercise the
// same pair on the platform router, under the same limit.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (EXERCISE_VIDEO_UPLOAD_PATH.test(req.path)) return exerciseVideoBodyParser(req, res, next);
  if (PLATFORM_EXERCISE_VIDEO_UPLOAD_PATH.test(req.path)) return platformExerciseVideoBodyParser(req, res, next);
  return next();
});

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

// #782: nightly-run freshness for an external prober (Grafana Cloud synthetic).
// Unauthenticated and deliberately outside /billing/, the internal-run surface
// with its own shared secret and rate limiter — see api/health.ts.
app.use('/health', healthRouter);

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
app.use('/billing', internalRunLimiter as any, billingRouter);

// #647 stage 4: internal nightly runner that maintains the rolling 2-month
// Personal Training booking window — same X-Internal-Secret pattern as /billing.
app.use('/recurring-bookings', internalRunLimiter as any, recurringBookingsRouter);

// #900: internal sweep that expires Promotions past their End Date — same
// X-Internal-Secret pattern, and a step of the billing workflow (see
// api/src/api/promotion-lifecycle.ts for why it shares that secret). Mounted
// here rather than on the tenant-scoped `/promotions` router below because it
// walks every gym.
app.use('/promotion-lifecycle', internalRunLimiter as any, promotionLifecycleRouter);

// #1227 stage 2: nightly renewal of plan Session Benefit allowances — same
// X-Internal-Secret pattern, a step of the billing workflow (shares its secret).
app.use('/plan-allowance-renewals', internalRunLimiter as any, planAllowanceRenewalsRouter);

// #1113: internal runner that raises the 2-hour training reminder — same
// X-Internal-Secret pattern, with its own secret because it has a schedule of
// its own (see api/src/api/booking-reminders.ts). Mounted here rather than on
// the tenant-scoped routers below because it walks every gym.
app.use('/booking-reminders', internalRunLimiter as any, bookingRemindersRouter);

// Theme logo — no auth (img tags in both apps need this)
app.use('/themes', themesPublicRouter);

// Gym listing/membership — auth required but no tenant context (gymId not known yet)
app.use('/gyms', requireAuth(), gymsRouter);

// Platform superadmin routes
app.use('/platform/themes', requireAuth(), themesRouter);
app.use('/platform/nutrition-library', requireAuth(), platformNutritionLibraryRouter);
app.use('/platform/personal-goals', requireAuth(), platformPersonalGoalsRouter);
app.use('/platform/nutrition-goals', requireAuth(), platformNutritionGoalsRouter);
app.use('/platform/nutrition-plan-templates', requireAuth(), platformNutritionPlanTemplatesRouter);
app.use('/platform/exercises', requireAuth(), platformExercisesRouter);
app.use('/platform/workout-templates', requireAuth(), platformWorkoutTemplatesRouter);
app.use('/platform/training-plan-templates', requireAuth(), platformTrainingPlanTemplatesRouter);
app.use('/platform', requireAuth(), platformRouter);
app.use('/platform/superadmins', requireAuth(), superadminsRouter);
app.use('/platform/orphaned-accounts', requireAuth(), orphanedAccountsRouter);
app.use('/platform/impersonation', requireAuth(), impersonationRouter);
app.use('/platform/feature-flags', requireAuth(), platformFeatureFlagsRouter);
// #1077: the published mobile builds (list + download), superadmin-only per route.
app.use('/platform/mobile-builds', requireAuth(), platformMobileBuildsRouter);
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
// #1036 — My Goals. Mounted BEFORE /me so Express reaches it rather than
// falling through meRouter's own 404, and with the same middleware chain:
// the two feature flags it needs are declared on the router itself, beside
// the rules that read them.
app.use('/me/personal-goals', requireAuth(), tenantContext, centerContext, mePersonalGoalsRouter);
// #1375: the member's own profile image. Mounted BEFORE /me for the same reason.
app.use('/me/profile/image', requireAuth(), tenantContext, centerContext, meProfileImageRouter);
// #1122: the Members App's Add Plan — the member's own Draft, Promotions and Save & Pay.
app.use('/me/membership-plans', requireAuth(), tenantContext, centerContext, meMembershipPlansRouter);
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
// #947/#948: the two goal catalogues. **Nutrition Goals** is still a tab of the
// Nutrition Library page, so it keeps that page's feature flag. **Personal Goals**
// is its own section since #948 (§3, §8/§9) and therefore has its own flag,
// `nutrition.personal_goals` (seeded by migration 211 from the Nutrition Library's
// current value, so nothing changes on deploy): gated on the Library's key, hiding
// Foods would 403 a section that is a different domain, and the nav item beside it
// would be the only thing left pointing at it.
// #1070: `requireFeatureAccess` rather than `requireModuleAccess` on all three,
// so a feature-level permission override (`FEATURE_PERMISSION_OVERRIDES`) is read
// from the same key `requireFeatureEnabled` is given beside it. With no override
// declared for a key the guard answers exactly what the module gate did.
app.use('/personal-goals', requireAuth(), tenantContext, requireFeatureAccess('nutrition.personal_goals', 'NUTRITION'), requireFeatureEnabled('nutrition.personal_goals'), personalGoalsRouter);
app.use('/nutrition-goals', requireAuth(), tenantContext, requireFeatureAccess('nutrition.nutrition_library', 'NUTRITION'), requireFeatureEnabled('nutrition.nutrition_library'), nutritionGoalsRouter);
// #948 §4: Assigned Personal Goals. Behind the **Personal Goals** flag and not a
// Nutrition one — the assignments are the catalogue's own domain (§8), and a gym
// that hid Personal Goals hid the goals its members hold with them.
app.use('/member-personal-goals', requireAuth(), tenantContext, requireFeatureAccess('nutrition.personal_goals', 'NUTRITION'), requireFeatureEnabled('nutrition.personal_goals'), memberPersonalGoalsRouter);
// #809: mounted on the Nutrition group flag, so turning the Nutrition Plans page off leaves the Dashboard readable.
app.use('/nutrition/dashboard', requireAuth(), tenantContext, requireModuleAccess('NUTRITION'), requireFeatureEnabled('nutrition'), nutritionDashboardRouter);

// FINANCIALS module — admin=RW, front_desk/accountant=R, trainer*/nutritionist/member=NONE
app.use('/membership-plans', requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.plans'), membershipPlansRouter);
// #638: Finance → Dashboard. Read-only aggregation; gated on the Financials
// group flag so it survives the Plans page being turned off.
app.use('/financials/dashboard', requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), financialsDashboardRouter);
app.use('/benefit-types',    requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), benefitTypesRouter);
app.use('/charge-types',     requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), chargeTypesRouter);
app.use('/action-types',     requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), actionTypesRouter);
app.use('/products',         requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.products'), productsRouter);
// Reads depend only on the Financials group flag: Plans and Products load /taxes for
// their tax dropdown. The Taxes page's own flag (financials.taxes) gates writes in the router (#610).
app.use('/taxes',            requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials'), taxesRouter);
app.use('/promotions',       requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.promotions'), promotionsRouter);
app.use('/promotions/:id',   requireAuth(), tenantContext, requireModuleAccess('FINANCIALS'), requireFeatureEnabled('financials.promotions'), promotionDetailsRouter);

// PAYMENTS module — admin/front_desk=RW, accountant=R, member=R_OWN (via /me/*), trainer*/nutritionist=NONE
app.use('/billing-events',   requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), billingEventsRouter);
// #635 stage 12: the Membership Fee drift report — two path segments, neither of
// which userMembershipsRouter has a route for ('/:id' is one segment). Stage 14
// gave it its own feature key (migration 190) so Payments → Membership Fee Drift
// can be switched off without taking Transactions with it, and vice versa — which
// only holds if it is mounted *before* '/user-memberships', whose own
// `payments.transactions` gate runs on every path under that prefix.
app.use('/user-memberships', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), userMembershipsRouter);
// #1325 PR 2d: the ProductSet-keyed commercial surface (staff) and the member's own read.
app.use('/product-sets', requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), productSetsRouter);
app.use('/me/product-sets', requireAuth(), tenantContext, centerContext, meProductSetsRouter);
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
app.use('/payment-methods',   requireAuth(), tenantContext, requireModuleAccess('PAYMENTS'), requireFeatureEnabled('payments.transactions'), paymentMethodsRouter);

// SYSTEM module — admin=RW, all others=NONE
app.use('/audit-logs',       requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.audit'), auditLogsRouter);
app.use('/system/themes',    requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.themes'), gymThemesRouter);
app.use('/system/website-integration', requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.website_integration'), websiteIntegrationRouter);
app.use('/system/localization', requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), gymLocalizationRouter);
app.use('/recycle-bin',      requireAuth(), tenantContext, requireModuleAccess('SYSTEM'), requireFeatureEnabled('system.recycle_bin'), recycleBinRouter);

// Global error handler — must be last, after all routes.
// #966: the real error is logged here and only here. What the client is told is
// `domain/httpErrorResponse.ts`'s decision — a deliberate status keeps its own
// message, anything else is a generic 500 — so a driver message such as
// `Unknown column 'b.result_type' in 'field list'` never reaches a toast.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(httpErrorStatus(err)).json({ error: publicErrorMessage(err) });
});
