import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';

function requireAuth() {
  return (req: Request, res: Response, next: NextFunction) => {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
}
import { membersRouter } from './api/members';
import { classesRouter } from './api/classes';
import { bookingsRouter } from './api/bookings';
import { subscriptionsRouter } from './api/subscriptions';
import { gymsRouter, platformRouter } from './api/gyms';
import { tenantContext } from './infra/tenantContext';
import { db } from './infra/db';
import { swaggerSpec } from './infra/swagger';

if (!process.env.FRONTEND_URL) {
  throw new Error('FRONTEND_URL environment variable is required');
}
if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY environment variable is required');
}

const app = express();
const port = process.env.PORT ?? 3001;

const allowedOrigins = (process.env.FRONTEND_URL ?? '').split(',').map((o) => o.trim());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use(clerkMiddleware());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// One-time dev seed — remove after use
app.post('/dev/seed-gym', async (req: any, res: any) => {
  const { user_id, gym_name, gym_slug } = req.body;
  if (!user_id || !gym_name || !gym_slug) return res.status(400).json({ error: 'user_id, gym_name, gym_slug required' });
  const { rows: [gym] } = await db.query(
    `INSERT INTO gyms (name, slug, plan) VALUES ($1, $2, 'free') ON CONFLICT (slug) DO UPDATE SET name=$1 RETURNING *`,
    [gym_name, gym_slug]
  );
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (user_id, gym_id) DO NOTHING`,
    [user_id, gym.id]
  );
  res.json({ gym, message: 'Gym created and user assigned as admin' });
});

app.use('/docs', swaggerUi.serve);
app.get('/docs', swaggerUi.setup(swaggerSpec, { customSiteTitle: 'Gymdesk API' }));

// Gym listing/membership — auth required but no tenant context (gymId not known yet)
app.use('/gyms', requireAuth(), gymsRouter);

// Platform superadmin routes
app.use('/platform', requireAuth(), platformRouter);

// Domain routes — require auth + tenant context (gym_id from x-gym-id header)
app.use('/members',       requireAuth(), tenantContext, membersRouter);
app.use('/classes',       requireAuth(), tenantContext, classesRouter);
app.use('/bookings',      requireAuth(), tenantContext, bookingsRouter);
app.use('/subscriptions', requireAuth(), tenantContext, subscriptionsRouter);

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
