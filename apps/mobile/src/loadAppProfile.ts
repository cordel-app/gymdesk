/**
 * #1074 (mobile app WP3) — the I/O half of the profile rule: it finds the
 * profile file and reads the environment, and hands both to the pure
 * `resolveAppProfile()` beside it.
 *
 * Split for the reason WP2 split `native.ts` from `nativePlugins.ts`: the
 * decisions stay assertable without a file system, and there is exactly one
 * place that knows a profile lives in `apps/mobile/profiles/<id>.json`.
 * `capacitor.config.ts` and `scripts/apply-profile.ts` both come through here,
 * so a `cap sync` and an apply can never disagree about what is being built.
 *
 * The workspace root is a **parameter** rather than something this module
 * derives: the Capacitor CLI transpiles `capacitor.config.ts` to CommonJS and
 * `tsx` runs the scripts as ES modules, so `__dirname` and `import.meta.url`
 * are each available in exactly one of the two callers. Each passes its own,
 * and this module keeps one way of finding a profile inside it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppProfileError,
  profileIdFromEnv,
  resolveAppProfile,
  type AppProfile,
  type AppProfileInput,
} from './appProfile';

export const PROFILES_DIRNAME = 'profiles';

export function profilesDir(workspaceRoot: string): string {
  return join(workspaceRoot, PROFILES_DIRNAME);
}

export function profilePath(workspaceRoot: string, id: string): string {
  return join(profilesDir(workspaceRoot), `${id}.json`);
}

/** Every profile this workspace holds — stage 1 has one, stage 2 adds files. */
export function availableProfileIds(workspaceRoot: string): string[] {
  const dir = profilesDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export function readProfileFile(workspaceRoot: string, id: string): AppProfileInput {
  const path = profilePath(workspaceRoot, id);
  if (!existsSync(path)) {
    throw new AppProfileError(
      `No app profile "${id}" (looked for ${path}). Profiles available: ${
        availableProfileIds(workspaceRoot).join(', ') || 'none'
      }.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AppProfileError(`App profile "${id}" is not valid JSON (${path}): ${String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppProfileError(`App profile "${id}" must be a JSON object (${path}).`);
  }
  return parsed as AppProfileInput;
}

/**
 * The profile this build is for: the file named by `MOBILE_APP_PROFILE`, with
 * each field overridden by its own environment variable.
 */
export function loadAppProfile(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): AppProfile {
  const id = profileIdFromEnv(env);
  return resolveAppProfile({ ...readProfileFile(workspaceRoot, id), id }, env);
}
