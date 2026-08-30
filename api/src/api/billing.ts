import { Router, Request, Response } from 'express';
import { db } from '../infra/db';

export const billingRouter = Router();

/**
 * Internal endpoint called by the nightly billing-run workflow.
 * Expires pending payment_requests whose page_token TTL has passed.
 * Auth: X-Internal-Secret header must match BILLING_INTERNAL_SECRET env var.
 */
billingRouter.post('/cleanup', async (req: Request, res: Response) => {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.BILLING_INTERNAL_SECRET;

  if (!expected || secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rowCount } = await db.query(
      `UPDATE payment_requests
       SET status = 'expired', page_token = NULL
       WHERE status = 'pending' AND page_token_expires < UTC_TIMESTAMP()`,
    );

    req.log.info({ expired: rowCount }, 'payment_requests cleanup: expired rows');
    res.json({ expired: rowCount });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'billing cleanup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
