/**
 * #1074 (mobile app WP3) — `npm run profile:show`: what this build is for.
 *
 * The shell's configuration is spread across a profile file and the
 * environment, resolved per field (`resolveAppProfile()`), so "which app am I
 * about to build" is a question worth one command rather than reading two
 * places. It writes nothing.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppProfileError } from '../src/appProfile';
import { availableProfileIds, loadAppProfile } from '../src/loadAppProfile';
import { NativeIdentityError, iosIdentity, urlSchemes } from '../src/nativeIdentity';

const WORKSPACE = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const profile = loadAppProfile(WORKSPACE);
  console.log(JSON.stringify({ ...profile, urlSchemes: urlSchemes(profile), ios: iosIdentity(profile) }, null, 2));
  console.log(`\nprofiles available: ${availableProfileIds(WORKSPACE).join(', ') || 'none'}`);
} catch (err) {
  if (err instanceof AppProfileError || err instanceof NativeIdentityError) {
    console.error(`profile:show failed — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
