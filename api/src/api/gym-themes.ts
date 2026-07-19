import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

// ─── Gym-admin theme management ───────────────────────────────────────────────

export const gymThemesRouter = Router();

const ALLOWED_MIME_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_STACKS = [
  'system-ui, -apple-system, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Courier New", Courier, monospace',
  'Arial, Helvetica, sans-serif',
  '"Trebuchet MS", sans-serif',
];

function validateTokens(tokens: any): string | null {
  if (!tokens || typeof tokens !== 'object') return 'tokens must be an object';
  const { colors, typography } = tokens;
  if (colors) {
    const hexFields = ['appBackground','headerBackground','headerText','headerSeparatorColor','sidebarBackground','sidebarText','sidebarSelectedBackground','sidebarSelectedText'];
    for (const f of hexFields) {
      if (colors[f] !== undefined && !HEX_RE.test(colors[f])) return `colors.${f} must be a hex color like #rrggbb`;
    }
    if (colors.headerSeparatorHeight !== undefined) {
      const h = Number(colors.headerSeparatorHeight);
      if (!Number.isInteger(h) || h < 0 || h > 20) return 'colors.headerSeparatorHeight must be an integer 0–20';
    }
  }
  if (typography) {
    const levels = ['h1','h2','h3','body','small'];
    for (const lv of levels) {
      if (!typography[lv]) continue;
      const { fontFamily, color } = typography[lv];
      if (fontFamily !== undefined && !FONT_STACKS.includes(fontFamily)) return `typography.${lv}.fontFamily must be one of the allowed stacks`;
      if (color !== undefined && !HEX_RE.test(color)) return `typography.${lv}.color must be a hex color`;
    }
  }
  return null;
}

function shapeTheme(row: any) {
  const { logo_bytes: _lb, ...rest } = row;
  return {
    ...rest,
    is_base: row.gym_id === null,
    has_logo: !!row.logo_mime,
    tokens: typeof row.tokens === 'string' ? JSON.parse(row.tokens) : (row.tokens ?? null),
  };
}

const SELECT_COLS = 'id, gym_id, name, status, logo_mime, logo_updated_at, tokens, created_at, modified_at, deleted_at';

// ─── List: base themes + customer themes for this gym ─────────────────────────

gymThemesRouter.get('/', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows } = await db.query(
        `SELECT ${SELECT_COLS} FROM themes
         WHERE (gym_id IS NULL OR gym_id = ?) AND deleted_at IS NULL
         ORDER BY gym_id IS NULL DESC, created_at ASC`,
        [gymId],
      );
      res.json(rows.map(shapeTheme));
    });
  } catch (err) { next(err); }
});

// ─── Clone a theme (base or customer) into a customer theme ───────────────────

gymThemesRouter.post('/clone/:sourceId', async (req, res, next) => {
  try {
    const { gymId, gymMembershipId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: source } = await db.query(
        `SELECT ${SELECT_COLS} FROM themes
         WHERE id = ? AND deleted_at IS NULL AND (gym_id IS NULL OR gym_id = ?)`,
        [req.params.sourceId, gymId],
      );
      if (source.length === 0) return res.status(404).json({ error: 'Theme not found' });

      const src = source[0];
      const baseName = req.body?.name?.trim() || `${src.name} (copy)`;

      // Ensure name uniqueness within the gym's customer themes.
      const { rows: nameConflict } = await db.query(
        'SELECT id FROM themes WHERE gym_id = ? AND name = ? AND deleted_at IS NULL',
        [gymId, baseName],
      );
      if (nameConflict.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });

      const id = randomUUID();
      const tokens = typeof src.tokens === 'string' ? src.tokens : JSON.stringify(src.tokens);
      await db.query(
        `INSERT INTO themes (id, gym_id, name, status, tokens, created_at)
         VALUES (?, ?, ?, 'draft', ?, UTC_TIMESTAMP())`,
        [id, gymId, baseName, tokens],
      );

      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [id]);
      recordAudit(req, { action: 'clone', entityType: 'theme', entityId: id, next: shapeTheme(rows[0]) });
      res.status(201).json(shapeTheme(rows[0]));
    });
  } catch (err) { next(err); }
});

// ─── Update a customer theme ──────────────────────────────────────────────────

gymThemesRouter.put('/:id', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: existingRows } = await db.query(
        `SELECT ${SELECT_COLS} FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
        [req.params.id, gymId],
      );
      if (existingRows.length === 0) return res.status(404).json({ error: 'Theme not found' });
      const current = existingRows[0];

      const { name, tokens, status } = req.body;
      const ALLOWED_STATUSES = ['draft', 'active'];
      if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
      }

      if (name !== undefined && name.trim() !== current.name) {
        const { rows: nameConflict } = await db.query(
          'SELECT id FROM themes WHERE gym_id = ? AND name = ? AND deleted_at IS NULL AND id != ?',
          [gymId, name.trim(), req.params.id],
        );
        if (nameConflict.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });
      }

      let tokensMerged = typeof current.tokens === 'string' ? JSON.parse(current.tokens) : current.tokens;
      if (tokens !== undefined) {
        tokensMerged = tokens;
        const err = validateTokens(tokensMerged);
        if (err) return res.status(400).json({ error: err });
      }

      await db.query(
        `UPDATE themes SET
           name    = COALESCE(?, name),
           status  = COALESCE(?, status),
           tokens  = ?
         WHERE id = ? AND gym_id = ?`,
        [name?.trim() ?? null, status ?? null, JSON.stringify(tokensMerged), req.params.id, gymId],
      );
      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
      recordAudit(req, { action: 'update', entityType: 'theme', entityId: req.params.id, previous: shapeTheme(current), next: shapeTheme(rows[0]) });
      res.json(shapeTheme(rows[0]));
    });
  } catch (err) { next(err); }
});

// ─── Logo upload (customer themes only) ───────────────────────────────────────

gymThemesRouter.post(
  '/:id/logo',
  express.raw({ type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'), limit: '600kb' }),
  async (req, res, next) => {
    try {
      const { gymId } = getTenantContext(req);
      await requireRole('admin')(req, res, async () => {
        const mime = req.headers['content-type']?.split(';')[0]?.trim();
        if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
          return res.status(415).json({ error: `Unsupported image type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` });
        }
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
        if (body.length > LOGO_MAX_BYTES) return res.status(413).json({ error: 'Logo exceeds 512 KB limit' });

        const { rows: existing } = await db.query(
          'SELECT id FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
          [req.params.id, gymId],
        );
        if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });

        await db.query(
          'UPDATE themes SET logo_bytes = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
          [body, mime, req.params.id],
        );
        const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
        res.json(shapeTheme(rows[0]));
      });
    } catch (err) { next(err); }
  },
);

// ─── Logo delete (customer themes only) ──────────────────────────────────────

gymThemesRouter.delete('/:id/logo', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: existing } = await db.query(
        'SELECT id FROM themes WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
        [req.params.id, gymId],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
      await db.query('UPDATE themes SET logo_bytes = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = ?', [req.params.id]);
      const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM themes WHERE id = ?`, [req.params.id]);
      res.json(shapeTheme(rows[0]));
    });
  } catch (err) { next(err); }
});

// ─── Soft delete (customer themes only) ──────────────────────────────────────

gymThemesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    await requireRole('admin')(req, res, async () => {
      const { rows: existing } = await db.query(
        'SELECT id, deleted_at FROM themes WHERE id = ? AND gym_id = ?',
        [req.params.id, gymId],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
      if (existing[0].deleted_at) return res.status(409).json({ error: 'Theme is already deleted' });

      const { rows: gymRefs } = await db.query('SELECT id FROM gyms WHERE theme_id = ? LIMIT 1', [req.params.id]);
      if (gymRefs.length > 0) {
        return res.status(409).json({ error: 'Theme is assigned as the gym default. Reassign it first.' });
      }
      const { rows: centerRefs } = await db.query(
        'SELECT id FROM centers WHERE theme_id = ? AND deleted_at IS NULL LIMIT 1',
        [req.params.id],
      );
      if (centerRefs.length > 0) {
        return res.status(409).json({ error: 'Theme is assigned to one or more centers. Reassign them first.' });
      }

      await db.query(
        "UPDATE themes SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ?",
        [req.params.id],
      );
      recordAudit(req, { action: 'delete', entityType: 'theme', entityId: req.params.id });
      res.status(204).send();
    });
  } catch (err) { next(err); }
});
