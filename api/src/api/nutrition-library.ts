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
    const where: string[] = [];
    const params: any[] = [];
    if (category) { where.push('category = ?'); params.push(category); }
    const { rows } = await db.query(
      `SELECT * FROM nutrition_library_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY category ASC, name ASC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});
