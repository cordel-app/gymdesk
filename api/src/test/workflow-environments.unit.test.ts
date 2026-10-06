// The GitHub environments a workflow may be dispatched into, and the one a
// schedule or a push falls back to, must be environments that exist.
//
// #784 named the production environment `production` in every
// `workflow_dispatch` choice; it was created as `pro` (2026-10-04), so a manual
// run on `production` targeted an environment holding no secrets and no
// `API_BASE_URL` — GitHub creates an empty one rather than refusing. This gate
// keeps the choices and the fallbacks inside the set that actually exists.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** The repository's GitHub environments (Settings → Environments). */
const GITHUB_ENVIRONMENTS = ['dev', 'pro'];

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));
const sources = files.map((file) => ({ file, text: readFileSync(join(WORKFLOWS, file), 'utf8') }));

describe('workflows name only GitHub environments that exist', () => {
  it('offers only existing environments in every environment choice', () => {
    let checked = 0;
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/options:\s*\[([^\]]*)\]/g)) {
        const options = match[1].split(',').map((o) => o.trim().replace(/^['"]|['"]$/g, ''));
        for (const option of options) {
          expect(GITHUB_ENVIRONMENTS, `${file}: option '${option}'`).toContain(option);
        }
        checked++;
      }
    }
    // Eight workflows take an environment input today; a regex that stopped
    // matching would make this gate vacuous.
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('falls back to an existing environment', () => {
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/environment:\s*\$\{\{\s*inputs\.environment\s*\|\|\s*'([^']+)'\s*\}\}/g)) {
        expect(GITHUB_ENVIRONMENTS, `${file}: fallback '${match[1]}'`).toContain(match[1]);
      }
      for (const match of text.matchAll(/^\s*environment:\s*([a-z]+)\s*$/gm)) {
        expect(GITHUB_ENVIRONMENTS, `${file}: environment '${match[1]}'`).toContain(match[1]);
      }
    }
  });
});
