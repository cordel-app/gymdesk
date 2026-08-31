import { Router } from 'express';
import { db } from '../infra/db';

export const nutritionLibraryRouter = Router();

const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;
type Category = typeof CATEGORIES[number];

nutritionLibraryRouter.get('/', async (req, res, next) => {
  const category = req.query.category as string | undefined;
  if (category && !CATEGORIES.includes(category as Category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }
  try {
    const where: string[] = ["status != 'deleted'"];
    const params: any[] = [];
    if (category) { where.push('category = ?'); params.push(category); }

    const { rows } = await db.query<{ id: number; name: string; category: string }>(
      `SELECT id, name, category FROM nutrition_library_items WHERE ${where.join(' AND ')} ORDER BY category ASC, name ASC`,
      params,
    );

    if (rows.length === 0) return res.json([]);

    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const { rows: qualityRows } = await db.query<{ item_id: number; slug: string }>(
      `SELECT nliq.item_id, nq.slug
       FROM nutrition_library_item_qualities nliq
       JOIN nutritional_qualities nq ON nq.id = nliq.quality_id
       WHERE nliq.item_id IN (${marks})
       ORDER BY nq.id`,
      ids,
    );

    const qualitiesMap: Record<number, string[]> = {};
    for (const row of qualityRows) {
      if (!qualitiesMap[row.item_id]) qualitiesMap[row.item_id] = [];
      qualitiesMap[row.item_id].push(row.slug);
    }

    res.json(rows.map((r) => ({ ...r, quality_slugs: qualitiesMap[r.id] ?? [] })));
  } catch (err) { next(err); }
});
