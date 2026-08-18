import { z, ZodTypeAny } from 'zod';
import type { Request, Response } from 'express';

export { z };

/**
 * Parse and validate req.query against a Zod schema.
 * Returns the parsed value on success, or sends a 400 and returns null.
 * Usage:
 *   const q = parseQuery(req, res, z.object({ member_id: z.coerce.number().int().positive().optional() }));
 *   if (!q) return;
 */
export function parseQuery<T extends ZodTypeAny>(
  req: Request,
  res: Response,
  schema: T,
): z.infer<T> | null {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues.map((i) => i.message).join('; ') });
    return null;
  }
  return result.data;
}

/**
 * Parse and validate req.body against a Zod schema.
 * Returns the parsed value on success, or sends a 400 and returns null.
 */
export function parseBody<T extends ZodTypeAny>(
  req: Request,
  res: Response,
  schema: T,
): z.infer<T> | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues.map((i) => i.message).join('; ') });
    return null;
  }
  return result.data;
}
