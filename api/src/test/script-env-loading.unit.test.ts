import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// #964 — an operator script must load `.env` BEFORE it imports the DB pool.
//
// Every script under `src/scripts/` reached for dotenv the same way:
//
//     import { config } from 'dotenv';
//     import { db } from '../infra/db';
//     …
//     config();
//
// and `../infra/db` builds its pool at module scope and throws
// `CORDEL_FITNESS_DB_HOST, _USER, _PASSWORD and _NAME environment variables are
// required` when they are missing. Imports run before the body, so `config()`
// was reached only if the pool had already been built — i.e. never, unless the
// variables were already exported in the shell. `npm run exercises:import-free-db`
// with a correct `api/.env` therefore died before it read a single row, which is
// why #964's catalogue had not been imported despite the importer being merged.
//
// `src/app.ts` and `src/infra/seed.ts` already had it right: a bare
// `import 'dotenv/config';` first, whose side effect runs in import order. This
// test is that convention made enforceable for the five scripts.
//
// A unit test — it reads the tree and touches neither the DB nor HTTP.

const SCRIPTS_DIR = join(__dirname, '..', 'scripts');
const scriptFiles = readdirSync(SCRIPTS_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort();

describe('operator scripts load dotenv before anything that reads the environment', () => {
  it('finds the scripts to check', () => {
    expect(scriptFiles.length).toBeGreaterThan(0);
  });

  it.each(scriptFiles)('%s imports dotenv for its side effect', (name) => {
    const source = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    expect(source).toContain("import 'dotenv/config';");
  });

  it.each(scriptFiles)('%s does not defer dotenv to a config() call', (name) => {
    const source = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    // The deferred form is the defect, whatever it is named on the way in.
    expect(source).not.toMatch(/from 'dotenv'/);
    expect(source).not.toMatch(/^config\(\);$/m);
  });

  it.each(scriptFiles)('%s loads dotenv before its first local import', (name) => {
    const source = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    const dotenvAt = source.indexOf("import 'dotenv/config';");
    // Any `../…` import may build a pool, read a credential or validate config
    // at module scope, so dotenv goes before all of them rather than before a
    // named list of them.
    const localImportAt = source.search(/^import .*from '\.\./m);
    expect(dotenvAt).toBeGreaterThanOrEqual(0);
    expect(localImportAt).toBeGreaterThanOrEqual(0);
    expect(dotenvAt).toBeLessThan(localImportAt);
  });
});
