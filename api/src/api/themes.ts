import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

// ─── Superadmin CRUD ──────────────────────────────────────────────────────────

export const themesRouter = Router();

// ─── Public logo endpoint (no auth) ──────────────────────────────────────────

export const themesPublicRouter = Router();

const ALLOWED_MIME_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024; // 512 KB

export function defaultTokens() {
  return {
    v: 1,
    typography: {
      h1:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
      h2:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
      h3:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
      body:  { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
      small: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#6b7280' },
    },
    colors: {
      appBackground:             '#f5f5f5',
      headerBackground:          '#1a1a2e',
      headerText:                '#ffffff',
      headerSeparatorColor:      '#6c63ff',
      headerSeparatorHeight:     2,
      sidebarBackground:         '#1a1a2e',
      sidebarText:               '#e5e7eb',
      sidebarSelectedBackground: '#6c63ff',
      sidebarSelectedText:       '#ffffff',
    },
  };
}

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
    type: row.gym_id === null ? 'system' : 'custom',
    has_logo: !!row.logo_mime,
    tokens: typeof row.tokens === 'string' ? JSON.parse(row.tokens) : (row.tokens ?? null),
  };
}

// ─── List ─────────────────────────────────────────────────────────────────────

themesRouter.get('/', requireSuperadmin, async (req, res) => {
  const status = req.query.status as string | undefined;
  const params: any[] = [];

  let whereClause = '1=1';
  if (status) {
    whereClause += ' AND t.status = ?';
    params.push(status);
  } else {
    whereClause += ' AND t.deleted_at IS NULL';
  }

  // usage_count: for system themes = distinct orgs using it; for custom = centers using it (direct or inherited)
  const sql = `
    SELECT
      t.id, t.gym_id, t.name, t.description, t.status,
      t.logo_mime, t.logo_updated_at, t.created_at, t.modified_at, t.deleted_at,
      g.name AS gym_name,
      CASE
        WHEN t.gym_id IS NULL THEN (
          SELECT COUNT(DISTINCT gg.id)
          FROM gyms gg
          LEFT JOIN centers cc ON cc.gym_id = gg.id AND cc.deleted_at IS NULL
          WHERE gg.theme_id = t.id OR cc.theme_id = t.id
        )
        ELSE (
          SELECT CASE
            WHEN EXISTS (SELECT 1 FROM gyms gg2 WHERE gg2.id = t.gym_id AND gg2.theme_id = t.id)
            THEN (SELECT COUNT(*) FROM centers cc2 WHERE cc2.gym_id = t.gym_id AND cc2.deleted_at IS NULL)
            ELSE (SELECT COUNT(*) FROM centers cc3 WHERE cc3.theme_id = t.id AND cc3.deleted_at IS NULL)
          END
        )
      END AS usage_count,
      EXISTS (SELECT 1 FROM gyms gd WHERE gd.theme_id = t.id) AS is_default
    FROM themes t
    LEFT JOIN gyms g ON g.id = t.gym_id
    WHERE ${whereClause}
    ORDER BY t.gym_id IS NULL DESC, t.created_at ASC
  `;
  const { rows } = await db.query(sql, params);
  res.json(rows.map((r: any) => ({ ...shapeTheme(r), gym_name: r.gym_name ?? null, usage_count: Number(r.usage_count), is_default: !!r.is_default })));
});

// ─── Get single ───────────────────────────────────────────────────────────────

themesRouter.get('/:id', requireSuperadmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.gym_id, t.name, t.description, t.status, t.logo_mime, t.logo_updated_at,
            t.tokens, t.created_at, t.modified_at, t.deleted_at, g.name AS gym_name,
            EXISTS (SELECT 1 FROM gyms gd WHERE gd.theme_id = t.id) AS is_default,
            CASE
              WHEN t.gym_id IS NULL THEN (
                SELECT COUNT(DISTINCT gg.id) FROM gyms gg
                LEFT JOIN centers cc ON cc.gym_id = gg.id AND cc.deleted_at IS NULL
                WHERE gg.theme_id = t.id OR cc.theme_id = t.id
              )
              ELSE (
                SELECT CASE
                  WHEN EXISTS (SELECT 1 FROM gyms gg2 WHERE gg2.id = t.gym_id AND gg2.theme_id = t.id)
                  THEN (SELECT COUNT(*) FROM centers cc2 WHERE cc2.gym_id = t.gym_id AND cc2.deleted_at IS NULL)
                  ELSE (SELECT COUNT(*) FROM centers cc3 WHERE cc3.theme_id = t.id AND cc3.deleted_at IS NULL)
                END
              )
            END AS usage_count
     FROM themes t LEFT JOIN gyms g ON g.id = t.gym_id
     WHERE t.id = ?`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Theme not found' });

  const [{ rows: auditRows }] = await Promise.all([
    db.query(
      `SELECT action, actor_name, created_at FROM audit_logs
       WHERE entity_type = 'theme' AND entity_id = ?
       ORDER BY created_at ASC`,
      [req.params.id],
    ),
  ]);
  const createEntry = auditRows.find((r: any) => r.action === 'create');
  const updateEntry = [...auditRows].reverse().find((r: any) => r.action === 'update');

  const row = rows[0];
  res.json({
    ...shapeTheme(row),
    gym_name: row.gym_name ?? null,
    usage_count: Number(row.usage_count),
    is_default: !!row.is_default,
    created_by_name: createEntry?.actor_name ?? null,
    modified_by_name: updateEntry?.actor_name ?? null,
  });
});

// ─── Create ───────────────────────────────────────────────────────────────────

themesRouter.post('/', requireSuperadmin, async (req, res) => {
  const { name, description, tokens } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  // Enforce name uniqueness among non-deleted rows.
  const { rows: existing } = await db.query(
    "SELECT id FROM themes WHERE name = ? AND deleted_at IS NULL",
    [name.trim()],
  );
  if (existing.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });

  const mergedTokens = tokens ?? defaultTokens();
  const err = validateTokens(mergedTokens);
  if (err) return res.status(400).json({ error: err });

  const id = randomUUID();
  await db.query(
    "INSERT INTO themes (id, name, description, status, tokens, created_at) VALUES (?, ?, ?, 'draft', ?, UTC_TIMESTAMP())",
    [id, name.trim(), description?.trim() ?? null, JSON.stringify(mergedTokens)],
  );
  const { rows } = await db.query(
    'SELECT id, gym_id, name, description, status, logo_mime, logo_updated_at, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [id],
  );
  recordAudit(req, { action: 'create', entityType: 'theme', entityId: id, next: shapeTheme(rows[0]) });
  res.status(201).json(shapeTheme(rows[0]));
});

// ─── Update name / tokens / status ───────────────────────────────────────────

themesRouter.put('/:id', requireSuperadmin, async (req, res) => {
  const { name, description, tokens, status } = req.body;
  const ALLOWED_STATUSES = ['draft', 'active'];
  if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
  }

  const { rows: existingRows } = await db.query(
    'SELECT id, name, status, tokens, logo_mime, logo_updated_at, deleted_at FROM themes WHERE id = ?',
    [req.params.id],
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'Theme not found' });
  const current = existingRows[0];
  if (current.deleted_at) return res.status(409).json({ error: 'Theme is deleted' });

  if (name !== undefined && name.trim() !== current.name) {
    const { rows: nameConflict } = await db.query(
      'SELECT id FROM themes WHERE name = ? AND deleted_at IS NULL AND id != ?',
      [name.trim(), req.params.id],
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
       name        = COALESCE(?, name),
       description = CASE WHEN ? IS NOT NULL THEN ? ELSE description END,
       status      = COALESCE(?, status),
       tokens      = ?
     WHERE id = ?`,
    [name?.trim() ?? null, description !== undefined ? description : null, description ?? null, status ?? null, JSON.stringify(tokensMerged), req.params.id],
  );
  const { rows } = await db.query(
    'SELECT id, gym_id, name, description, status, logo_mime, logo_updated_at, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [req.params.id],
  );
  recordAudit(req, { action: 'update', entityType: 'theme', entityId: req.params.id, previous: shapeTheme(current), next: shapeTheme(rows[0]) });
  res.json(shapeTheme(rows[0]));
});

// ─── Logo upload ──────────────────────────────────────────────────────────────

themesRouter.post(
  '/:id/logo',
  requireSuperadmin,
  express.raw({ type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'), limit: '600kb' }),
  async (req, res) => {
    const mime = req.headers['content-type']?.split(';')[0]?.trim();
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
      return res.status(415).json({ error: `Unsupported image type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` });
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
    if (body.length > LOGO_MAX_BYTES) {
      return res.status(413).json({ error: 'Logo exceeds 512 KB limit' });
    }

    const { rows: existing } = await db.query('SELECT id FROM themes WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });

    await db.query(
      'UPDATE themes SET logo_bytes = ?, logo_mime = ?, logo_updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [body, mime, req.params.id],
    );
    const { rows } = await db.query(
      'SELECT id, gym_id, name, description, status, logo_mime, logo_updated_at, tokens, created_at, modified_at FROM themes WHERE id = ?',
      [req.params.id],
    );
    res.json(shapeTheme(rows[0]));
  },
);

// ─── Logo delete ──────────────────────────────────────────────────────────────

themesRouter.delete('/:id/logo', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query('SELECT id FROM themes WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
  await db.query('UPDATE themes SET logo_bytes = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = ?', [req.params.id]);
  const { rows } = await db.query(
    'SELECT id, gym_id, name, description, status, logo_mime, logo_updated_at, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [req.params.id],
  );
  res.json(shapeTheme(rows[0]));
});

// ─── Clone a base theme into a new base theme ────────────────────────────────

themesRouter.post('/clone/:sourceId', requireSuperadmin, async (req, res) => {
  const { rows: source } = await db.query(
    'SELECT id, name, tokens FROM themes WHERE id = ? AND gym_id IS NULL AND deleted_at IS NULL',
    [req.params.sourceId],
  );
  if (source.length === 0) return res.status(404).json({ error: 'Theme not found' });

  const src = source[0];
  const baseName = req.body?.name?.trim() || `${src.name} (copy)`;

  const { rows: nameConflict } = await db.query(
    'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? AND deleted_at IS NULL',
    [baseName],
  );
  if (nameConflict.length > 0) return res.status(409).json({ error: 'A theme with this name already exists' });

  const id = randomUUID();
  const tokens = typeof src.tokens === 'string' ? src.tokens : JSON.stringify(src.tokens);
  await db.query(
    "INSERT INTO themes (id, gym_id, name, status, tokens, created_at) VALUES (?, NULL, ?, 'draft', ?, UTC_TIMESTAMP())",
    [id, baseName, tokens],
  );
  const { rows } = await db.query(
    'SELECT id, gym_id, name, description, status, logo_mime, logo_updated_at, tokens, created_at, modified_at FROM themes WHERE id = ?',
    [id],
  );
  recordAudit(req, { action: 'clone', entityType: 'theme', entityId: id, next: shapeTheme(rows[0]) });
  res.status(201).json(shapeTheme(rows[0]));
});

// ─── Soft delete ──────────────────────────────────────────────────────────────

themesRouter.delete('/:id', requireSuperadmin, async (req, res) => {
  const { rows: existing } = await db.query('SELECT id, deleted_at FROM themes WHERE id = ?', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'Theme not found' });
  if (existing[0].deleted_at) return res.status(409).json({ error: 'Theme is already deleted' });

  // Guard: refuse if any gym or center still references this theme.
  const { rows: gymRefs } = await db.query('SELECT id FROM gyms WHERE theme_id = ? LIMIT 1', [req.params.id]);
  if (gymRefs.length > 0) {
    return res.status(409).json({ error: 'Theme is assigned to one or more gyms. Reassign them first.' });
  }
  const { rows: centerRefs } = await db.query('SELECT id FROM centers WHERE theme_id = ? AND deleted_at IS NULL LIMIT 1', [req.params.id]);
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

// ─── Public logo endpoint ─────────────────────────────────────────────────────

themesPublicRouter.get('/:id/logo', async (req, res) => {
  const { rows } = await db.query(
    'SELECT logo_bytes, logo_mime FROM themes WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  );
  if (rows.length === 0 || !rows[0].logo_bytes || !rows[0].logo_mime) {
    return res.status(404).json({ error: 'Logo not found' });
  }
  res.set('Content-Type', rows[0].logo_mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].logo_bytes);
});
