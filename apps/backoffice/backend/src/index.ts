import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { membersRouter } from './api/members';
import { classesRouter } from './api/classes';
import { bookingsRouter } from './api/bookings';
import { subscriptionsRouter } from './api/subscriptions';

if (!process.env.FRONTEND_URL) {
  throw new Error('FRONTEND_URL environment variable is required');
}

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/members', membersRouter);
app.use('/classes', classesRouter);
app.use('/bookings', bookingsRouter);
app.use('/subscriptions', subscriptionsRouter);

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
