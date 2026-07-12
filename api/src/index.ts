import 'dotenv/config';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { Request, Response, NextFunction } from 'express';
import { membersRouter } from './api/members';
import { classesRouter } from './api/classes';
import { bookingsRouter } from './api/bookings';
import { userMembershipsRouter } from './api/user-memberships';
import { gymsRouter, platformRouter } from './api/gyms';
import { membershipPlansRouter } from './api/membership-plans';
import { benefitTypesRouter } from './api/benefit-types';
import { chargeTypesRouter } from './api/charge-types';
import { billingEventsRouter } from './api/billing-events';
import { roomsRouter } from './api/rooms';
import { specialitiesRouter } from './api/specialities';
import { trainersRouter } from './api/trainers';
import { publicRouter } from './api/public';
import { meRouter, meLinkRouter } from './api/me';
import { tenantContext } from './infra/tenantContext';
import { db } from './infra/db';
import { swaggerSpec } from './infra/swagger';

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY environment variable is required');
}

const app = express();
const port = process.env.PORT ?? 3000;

// No CORS middleware: the API is only called server-to-server (Next.js proxy routes)
app.use(express.json());
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

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
  await db.query(
    `INSERT INTO gyms (name, slug, plan) VALUES (?, ?, 'free') AS new ON DUPLICATE KEY UPDATE name = new.name`,
    [gym_name, gym_slug]
  );
  const { rows: [gym] } = await db.query('SELECT * FROM gyms WHERE slug = ?', [gym_slug]);
  await db.query(
    `INSERT IGNORE INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, 'admin')`,
    [user_id, gym.id]
  );
  res.json({ gym, message: 'Gym created and user assigned as admin' });
});

app.use('/docs', swaggerUi.serve as any);
app.get('/docs', swaggerUi.setup(swaggerSpec, { customSiteTitle: 'Gymdesk API' }) as any);

// Public endpoints — no auth, no tenant context (identified by gym slug)
app.use('/public', publicRouter);

// Gym listing/membership — auth required but no tenant context (gymId not known yet)
app.use('/gyms', requireAuth(), gymsRouter);

// Platform superadmin routes
app.use('/platform', requireAuth(), platformRouter);

// Domain routes — require auth + tenant context (gym_id from x-gym-id header)
// /me/link must come before tenantContext (no membership row exists yet on first link)
app.use('/me/link', requireAuth(), meLinkRouter);
app.use('/me',      requireAuth(), tenantContext, meRouter);

app.use('/members',       requireAuth(), tenantContext, membersRouter);
app.use('/classes',       requireAuth(), tenantContext, classesRouter);
app.use('/bookings',      requireAuth(), tenantContext, bookingsRouter);
app.use('/user-memberships', requireAuth(), tenantContext, userMembershipsRouter);
app.use('/membership-plans', requireAuth(), tenantContext, membershipPlansRouter);
app.use('/benefit-types',    requireAuth(), tenantContext, benefitTypesRouter);
app.use('/charge-types',     requireAuth(), tenantContext, chargeTypesRouter);
app.use('/billing-events',   requireAuth(), tenantContext, billingEventsRouter);
app.use('/rooms',            requireAuth(), tenantContext, roomsRouter);
app.use('/specialities',     requireAuth(), tenantContext, specialitiesRouter);
app.use('/trainers',         requireAuth(), tenantContext, trainersRouter);

// Global error handler — must be last, after all routes
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
