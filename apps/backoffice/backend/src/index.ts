import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import { membersRouter } from './api/members';
import { classesRouter } from './api/classes';
import { bookingsRouter } from './api/bookings';
import { subscriptionsRouter } from './api/subscriptions';
import { gymsRouter, platformRouter } from './api/gyms';
import { tenantContext } from './infra/tenantContext';
import { swaggerSpec } from './infra/swagger';

if (!process.env.FRONTEND_URL) {
  throw new Error('FRONTEND_URL environment variable is required');
}
if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY environment variable is required');
}

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use(clerkMiddleware());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
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
