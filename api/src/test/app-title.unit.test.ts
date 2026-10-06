import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';

// #1114 — the two apps' browser titles are composed in one module each, and the
// *shape* of that composition is shared: `(<label>) <role> - <brand>`, with the
// label and the brand coming from two environment variables of the same name in
// both apps and only the role spelled in code.
//
// Nothing at runtime notices this breaking. A title literal put back into a
// layout renders perfectly well — it just stops following the environment, which
// is how `Gymdesk` came to be the same string in both apps and in both
// environments. The variables are equally silent: a build that passes neither
// shows the role alone, which is correct but unbranded, so the gate is also what
// says they are wired all the way from the deploy workflow to the module.
//
// This lives in the API suite for #1009's reason — CI runs `npm test` in `api/`
// only — which is why it reads both apps from here rather than from their own
// suites. Each app's own suite asserts the four titles the ticket names.

const REPO = join(__dirname, '..', '..', '..');
const APPS = [
  { app: 'admin', role: 'Admin', workflow: 'deploy-admin.yml' },
  { app: 'member', role: 'Members', workflow: 'deploy-member.yml' },
] as const;

const ENV_LABEL_VAR = 'NEXT_PUBLIC_APP_ENV_LABEL';
const BRAND_VAR = 'NEXT_PUBLIC_APP_BRAND_NAME';

function read(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf-8');
}

/** The file with its comments removed, so prose naming the retired title or a
 * brand does not read as code. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the browser title is composed in one place per app (#1114)', () => {
  for (const { app, role, workflow } of APPS) {
    describe(app, () => {
      const title = read('apps', app, 'src', 'lib', 'appTitle.ts');
      const layout = read('apps', app, 'src', 'app', '[locale]', 'layout.tsx');

      it('declares the app role as its one literal', () => {
        expect(title).toContain(`export const APP_ROLE = '${role}';`);
      });

      it('reads the same two environment variables as the other app', () => {
        expect(title).toContain(`export const APP_ENV_LABEL_VAR = '${ENV_LABEL_VAR}';`);
        expect(title).toContain(`export const APP_BRAND_NAME_VAR = '${BRAND_VAR}';`);
      });

      // Next.js substitutes that exact member expression at build time, so a
      // dynamic lookup resolves to nothing in the browser — and the title is
      // read in a client component (the admin's signed-out card, the header).
      it('reads the variables as static process.env members', () => {
        expect(title).toContain(`process.env.${ENV_LABEL_VAR}`);
        expect(title).toContain(`process.env.${BRAND_VAR}`);
      });

      it('takes its environment as an argument, so the composition stays pure', () => {
        expect(title).toMatch(/export function appTitle\(env: AppTitleEnv\)/);
      });

      it('is what the layout titles the document with', () => {
        expect(layout).toContain("from '@/lib/appTitle'");
        expect(layout).toContain('title: publicAppTitle(),');
      });

      it('leaves no title literal in the layout', () => {
        expect(withoutComments(layout)).not.toMatch(/title:\s*'/);
      });

      // The brand and the label are deployment facts, so they cross the whole
      // chain: the workflow's environment variables, the image's build args, the
      // bundle. A link missing anywhere leaves the title unbranded in that
      // environment and nothing fails.
      it('is a build arg of the image, defaulted to empty rather than to a brand', () => {
        const dockerfile = read('apps', app, 'Dockerfile');
        expect(dockerfile).toContain(`ARG ${ENV_LABEL_VAR}=\n`);
        expect(dockerfile).toContain(`ARG ${BRAND_VAR}=\n`);
        expect(dockerfile).toContain(`ENV ${ENV_LABEL_VAR}=$${ENV_LABEL_VAR}`);
        expect(dockerfile).toContain(`${BRAND_VAR}=$${BRAND_VAR}`);
      });

      it('is passed by the deploy workflow from the environment, not a literal', () => {
        const wf = read('.github', 'workflows', workflow);
        expect(wf).toContain(`${ENV_LABEL_VAR}=\${{ vars.APP_ENV_LABEL }}`);
        expect(wf).toContain(`${BRAND_VAR}=\${{ vars.APP_BRAND_NAME }}`);
      });

      it('is declared in the app .env.example with the development values', () => {
        const example = read('apps', app, '.env.example');
        expect(example).toContain(`${ENV_LABEL_VAR}=Dev`);
        expect(example).toContain(`${BRAND_VAR}=Cordel.tech Fitness`);
      });

      // The whole point of the ticket: the retired name is not a string either
      // app can still answer. `@gymdesk/*` package specifiers are not it.
      it('does not spell the retired application name anywhere in src', () => {
        const offenders = sourceFiles(join(REPO, 'apps', app, 'src')).filter((file) => {
          if (file.includes(`${sep}test${sep}`)) return false;
          const body = withoutComments(readFileSync(file, 'utf-8')).replace(/@gymdesk\/[\w-]+/g, '');
          return /gymdesk/i.test(body);
        });
        expect(offenders).toEqual([]);
      });
    });
  }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
