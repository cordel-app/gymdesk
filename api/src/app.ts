import 'dotenv/config';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { Request, Response, NextFunction } from 'express';
import { membersRouter } from './api/members';
import { bookingsRouter } from './api/bookings';
import { userMembershipsRouter } from './api/user-memberships';
import { gymsRouter, platformRouter } from './api/gyms';
import { superadminsRouter } from './api/superadmins';
import { impersonationRouter } from './api/impersonation';
import { membershipPlansRouter } from './api/membership-plans';
import { benefitTypesRouter } from './api/benefit-types';
import { chargeTypesRouter } from './api/charge-types';
import { billingEventsRouter } from './api/billing-events';
import { spacesRouter } from './api/spaces';
import { specialitiesRouter } from './api/specialities';
import { trainersRouter } from './api/trainers';
import { activityTypesRouter } from './api/activity-types';
import { classSessionsRouter } from './api/class-sessions';
// Side-effect import: registers the booking access hook for plan allowances + center validation.
import './api/plan-allowances';
import { classPackagesRouter } from './api/class-packages';
import { userClassPackagesRouter } from './api/user-class-packages';
import { actionTypesRouter } from './api/action-types';
import { promotionsRouter } from './api/promotions';
import { promotionDetailsRouter } from './api/promotion-details';
import { membershipPromotionsRouter } from './api/membership-promotions';
import { musclesRouter, exercisesRouter } from './api/exercises';
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
import { eventsRouter } from './api/events';
// Side-effect import: registers the booking access hook for package credits.
// Must be imported BEFORE plan-allowances so its hook is queued first
// (plan-access checks getPackageIntent to know whether to bail on 403).
import './api/package-credits';
import { publicRouter } from './api/public';
import { meRouter, meLinkRouter, meGymRouter } from './api/me';
import { themesRouter, themesPublicRouter } from './api/themes';
import { gymThemesRouter } from './api/gym-themes';
import { gymUsersRouter, gymUsersLinkRouter } from './api/gym-users';
import { staffRouter } from './api/staff';
import { paymentsRouter } from './api/payments';
import { nutritionPlanTemplatesRouter } from './api/nutrition-plan-templates';
import { dishesRouter, sidesRouter, saucesRouter } from './api/meals-catalog';
import { clerkWebhookRouter } from './api/webhooks';
import { tenantContext } from './infra/tenantContext';
import { centerContext } from './infra/centerContext';
import { swaggerSpec } from './infra/swagger';

export const app = express();

// Clerk webhooks must be mounted BEFORE express.json(): signature verification
// needs the exact raw request bytes, so this route parses its own raw body.
app.use('/webhooks/clerk', express.raw({ type: 'application/json' }), clerkWebhookRouter);

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

// One-time dev seed — remove after use
app.post('/dev/seed-gym', async (req: any, res: any) => {
  const { user_id, gym_name, gym_slug } = req.body;
  if (!user_id || !gym_name || !gym_slug) return res.status(400).json({ error: 'user_id, gym_name, gym_slug required' });
  const { db } = await import('./infra/db');
  await db.query(
    `INSERT INTO gyms (name, slug, plan) VALUES (?, ?, 'free') AS new ON DUPLICATE KEY UPDATE name = new.name`,
    [gym_name, gym_slug]
  );
  const { rows: [gym] } = await db.query('SELECT * FROM gyms WHERE slug = ?', [gym_slug]);
  await db.query(
    `INSERT IGNORE INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, 'admin')`,
    [user_id, gym.id]
  );
  // #59: dev-seeded gyms need a Center too, same as platformRouter.post('/gyms').
  await db.query(
    `INSERT INTO centers (gym_id, name, status)
     SELECT ?, ?, 'active' WHERE NOT EXISTS (SELECT 1 FROM centers WHERE gym_id = ? AND deleted_at IS NULL)`,
    [gym.id, gym.name, gym.id]
  );
  res.json({ gym, message: 'Gym created and user assigned as admin' });
});

app.use('/docs', swaggerUi.serve as any);
app.get('/docs', swaggerUi.setup(swaggerSpec, { customSiteTitle: 'Gymdesk API' }) as any);

// Public endpoints — no auth, no tenant context (identified by gym slug)
app.use('/public', publicRouter);

// Theme logo — no auth (img tags in both apps need this)
app.use('/themes', themesPublicRouter);

// Gym listing/membership — auth required but no tenant context (gymId not known yet)
app.use('/gyms', requireAuth(), gymsRouter);

// Platform superadmin routes
app.use('/platform/themes', requireAuth(), themesRouter);
app.use('/system/themes', requireAuth(), tenantContext, gymThemesRouter);
app.use('/platform', requireAuth(), platformRouter);
app.use('/platform/superadmins', requireAuth(), superadminsRouter);
app.use('/platform/impersonation', requireAuth(), impersonationRouter);

// Domain routes — require auth + tenant context (gym_id from x-gym-id header)
// /me/link + /gym-users/link must come before tenantContext (no membership row exists yet on first link)
app.use('/me/link', requireAuth(), meLinkRouter);
app.use('/gym-users/link', requireAuth(), gymUsersLinkRouter);
// /me/gym must come BEFORE /me to avoid being swallowed by tenantContext
app.use('/me/gym', requireAuth(), meGymRouter);
app.use('/me',      requireAuth(), tenantContext, centerContext, meRouter);

app.use('/gym-users',     requireAuth(), tenantContext, gymUsersRouter);
app.use('/members',       requireAuth(), tenantContext, membersRouter);
app.use('/members/:memberId/centers', requireAuth(), tenantContext, centerContext, memberCentersRouter);
app.use('/bookings',      requireAuth(), tenantContext, centerContext, bookingsRouter);
app.use('/user-memberships', requireAuth(), tenantContext, userMembershipsRouter);
app.use('/user-memberships/:id/promotions', requireAuth(), tenantContext, membershipPromotionsRouter);
app.use('/muscles',          requireAuth(), tenantContext, musclesRouter);
app.use('/exercises',        requireAuth(), tenantContext, exercisesRouter);
app.use('/workout-templates', requireAuth(), tenantContext, workoutTemplatesRouter);
app.use('/training-plan-templates', requireAuth(), tenantContext, trainingPlanTemplatesRouter);
app.use('/nutrition-plan-templates', requireAuth(), tenantContext, nutritionPlanTemplatesRouter);
app.use('/dishes',  requireAuth(), tenantContext, dishesRouter);
app.use('/sides',   requireAuth(), tenantContext, sidesRouter);
app.use('/sauces',  requireAuth(), tenantContext, saucesRouter);
app.use('/training-plans', requireAuth(), tenantContext, gymTrainingPlansRouter);
app.use('/members/:memberId/training-plans', requireAuth(), tenantContext, trainingPlansRouter);
app.use('/members/:memberId/member-training-plans', requireAuth(), tenantContext, memberTrainingPlansRouter);
app.use('/members/:memberId/exercise-logs', requireAuth(), tenantContext, exerciseLogsRouter);
app.use('/members/:memberId/workout-block-logs', requireAuth(), tenantContext, workoutBlockLogsRouter);
app.use('/audit-logs',       requireAuth(), tenantContext, auditLogsRouter);
app.use('/membership-plans', requireAuth(), tenantContext, membershipPlansRouter);
app.use('/benefit-types',    requireAuth(), tenantContext, benefitTypesRouter);
app.use('/charge-types',     requireAuth(), tenantContext, chargeTypesRouter);
app.use('/billing-events',   requireAuth(), tenantContext, billingEventsRouter);
app.use('/spaces',           requireAuth(), tenantContext, centerContext, spacesRouter);
app.use('/specialities',     requireAuth(), tenantContext, specialitiesRouter);
app.use('/trainers',         requireAuth(), tenantContext, trainersRouter);
app.use('/staff',            requireAuth(), tenantContext, staffRouter);
app.use('/activity-types',   requireAuth(), tenantContext, activityTypesRouter);
app.use('/class-sessions',   requireAuth(), tenantContext, centerContext, classSessionsRouter);
app.use('/class-packages',   requireAuth(), tenantContext, classPackagesRouter);
app.use('/action-types',     requireAuth(), tenantContext, actionTypesRouter);
app.use('/promotions',       requireAuth(), tenantContext, promotionsRouter);
app.use('/promotions/:id',   requireAuth(), tenantContext, promotionDetailsRouter);
app.use('/members/:memberId/class-packages', requireAuth(), tenantContext, userClassPackagesRouter);
app.use('/centers',          requireAuth(), tenantContext, centerContext, centersRouter);
app.use('/trainer-availability', requireAuth(), tenantContext, centerContext, trainerAvailabilityRouter);
app.use('/events',           requireAuth(), tenantContext, centerContext, eventsRouter);
app.use('/payments',         requireAuth(), tenantContext, paymentsRouter);

// Global error handler — must be last, after all routes
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
