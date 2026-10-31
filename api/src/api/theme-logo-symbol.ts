// #2157: upload / remove of a Theme's logo symbol (`logo_symbol.webp`, the
// favicon), shared by the Custom Theme router (`/system/themes`) and the Base
// Theme router (`/platform/themes`). The two differ only in who may call, which
// themes they may reach, which folder root the key hangs off and who is recorded
// as the actor, so those arrive as a `scope`; validation, processing, storage and
// error shapes are written once.
//
// Independent of the full logo by construction: it reads and writes
// `logo_symbol_object_key` only, so replacing or removing one asset never touches
// the other.

import express from 'express';
import { db } from '../infra/db';
import {
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getStorageDiagnostics,
  StorageOperationError,
  uploadStorageObject,
} from '../infra/storage';
import { folderStageForKey } from '../domain/storageFailureStage';
import { storageCauseFromDetails } from '../domain/storageFailureCause';
import { MEMBER_IMAGE_REJECTION_MESSAGES } from '../domain/memberImages';
import { buildThemeLogoSymbolKey, processLogoSymbol } from '../domain/themeLogoSymbol';
import { logger } from '../lib/logger';

/** Raw upload ceiling; the server shrinks it to at most 512 px wide anyway. */
export const LOGO_SYMBOL_MAX_BYTES = 5 * 1024 * 1024;

export const logoSymbolBodyParser = express.raw({
  type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'),
  limit: LOGO_SYMBOL_MAX_BYTES,
});

export interface LogoSymbolScope {
  /** `AND` fragment + params that confine a lookup to the caller's themes. */
  themeWhere: { sql: string; params: any[] };
  /** The folder root (prefix) and the extra markers above the theme folder; null once the response is sent. */
  resolveRoot: () => Promise<{ prefix: string; rootFolderKeys: string[] } | null>;
  actor: () => string | null;
  /** Sends the refreshed theme. */
  respond: (themeId: string) => Promise<unknown>;
  logContext: Record<string, unknown>;
}

interface ThemeRow { id: string; name: string; logo_symbol_object_key: string | null }

async function findTheme(scope: LogoSymbolScope, id: string): Promise<ThemeRow | null> {
  const { rows } = await db.query<ThemeRow>(
    `SELECT id, name, logo_symbol_object_key FROM themes WHERE id = ? AND deleted_at IS NULL ${scope.themeWhere.sql}`,
    [id, ...scope.themeWhere.params],
  );
  return rows[0] ?? null;
}

export async function uploadLogoSymbol(scope: LogoSymbolScope, req: express.Request, res: express.Response) {
  const raw: unknown = req.body;
  if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
    return res.status(400).json({ error: 'Request body must be raw image bytes', cause: 'invalid_file' });
  }
  if (raw.length === 0) return res.status(400).json({ error: 'Request body is empty', cause: 'invalid_file' });

  const theme = await findTheme(scope, String(req.params.id));
  if (!theme) return res.status(404).json({ error: 'Theme not found', cause: 'not_found' });

  // Judged from the decoded bytes, never the Content-Type or the file name.
  const processed = await processLogoSymbol(raw);
  if ('rejection' in processed) {
    return res.status(415).json({ error: MEMBER_IMAGE_REJECTION_MESSAGES[processed.rejection], cause: 'invalid_file' });
  }

  const root = await scope.resolveRoot();
  if (!root) return;
  const key = buildThemeLogoSymbolKey(root.prefix, theme.id, theme.name);
  // Outermost first: the root's markers, the theme's own folder, then its `logo/` leaf.
  const markers = [
    ...root.rootFolderKeys,
    `${key.slice(0, key.lastIndexOf('/logo/'))}/`,
    `${key.slice(0, key.lastIndexOf('/'))}/`,
  ];

  try {
    await ensureStorageFolders(markers);
  } catch (err: any) {
    const details = err instanceof StorageOperationError ? err.details : describeStorageError(err, { operation: 'ensureStorageFolders', key });
    logger.error({ err, details, diagnostics: getStorageDiagnostics(), ...scope.logContext, themeId: theme.id }, 'Cloudflare R2 theme logo symbol folder creation failed');
    return res.status(502).json({
      error: `Failed to create the theme logo folder: ${details.message}`,
      stage: folderStageForKey(details.key, markers, 'create_logo_folder'),
      path: details.key ?? key,
      cause: storageCauseFromDetails(details),
      details,
    });
  }

  try {
    await uploadStorageObject(key, 'image/webp', processed.image);
  } catch (err: any) {
    const details = err instanceof StorageOperationError ? err.details : describeStorageError(err, { operation: 'uploadStorageObject', key });
    logger.error({ err, details, diagnostics: getStorageDiagnostics(), ...scope.logContext, themeId: theme.id }, 'Cloudflare R2 theme logo symbol upload failed');
    return res.status(502).json({
      error: `Failed to upload logo symbol: ${details.message}`,
      stage: 'upload_logo',
      path: key,
      cause: storageCauseFromDetails(details),
      details,
    });
  }

  // The key is fixed (always .webp), so it only differs for a renamed theme: the
  // old object is an orphan, swept best-effort after the new one is safe.
  const previousKey = theme.logo_symbol_object_key;
  if (previousKey && previousKey !== key) {
    try {
      await deleteStorageObject(previousKey);
    } catch (err: any) {
      logger.warn({ err, themeId: theme.id }, 'Replaced theme logo symbol left an orphaned object in Cloudflare R2');
    }
  }

  await db.query(
    'UPDATE themes SET logo_symbol_object_key = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?',
    [key, scope.actor(), theme.id],
  );
  return scope.respond(theme.id);
}

export async function removeLogoSymbol(scope: LogoSymbolScope, req: express.Request, res: express.Response) {
  const theme = await findTheme(scope, String(req.params.id));
  if (!theme) return res.status(404).json({ error: 'Theme not found', cause: 'not_found' });

  const key = theme.logo_symbol_object_key;
  if (key) {
    // As the full logo: a failed delete is reported and the row left alone, so a
    // reference is never cleared while its object survives.
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError ? err.details : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.error({ err, details, diagnostics: getStorageDiagnostics(), ...scope.logContext, themeId: theme.id }, 'Cloudflare R2 theme logo symbol delete failed');
      return res.status(502).json({
        error: `Failed to remove logo symbol: ${details.message}`,
        stage: 'remove_logo',
        path: key,
        cause: storageCauseFromDetails(details),
        details,
      });
    }
  }
  await db.query(
    'UPDATE themes SET logo_symbol_object_key = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?',
    [scope.actor(), theme.id],
  );
  return scope.respond(theme.id);
}
