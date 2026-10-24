// The three corfront deploys write their app's runtime environment from
// GitHub, exactly as deploy.yml does for the API (#1177).
//
// Until this gate they only pulled the image and restarted the unit, so every
// runtime value lived hand-written in Oscar's quadlets — which is how the
// payment app kept proxying to `api.vdicube.com` after that hostname lost its
// Traefik route, and every checkout link answered "expired". Each workflow now
// deletes the unit's `Environment=` lines and writes its own block, so a value
// the app reads that the workflow does not write cannot be set at all.
//
// The names are derived from the code where the code names them, so a new
// runtime setting cannot be read without being forwarded.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const workflow = (name: string) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every non-`NEXT_PUBLIC_*` variable a Next app's server code reads. */
function runtimeEnvRead(app: string): string[] {
  const names = new Set<string>();
  for (const file of sources(join(ROOT, 'apps', app, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z_0-9]+)/g)) names.add(m[1]);
    for (const m of text.matchAll(/ENV_KEY = '([A-Z][A-Z_0-9]+)'/g)) names.add(m[1]);
  }
  return [...names].filter((n) => !n.startsWith('NEXT_PUBLIC_') && n !== 'NODE_ENV').sort();
}

/** The `${NAME}` placeholders the payment app's nginx template substitutes. */
const PAYMENT_TEMPLATE_VARS = [
  ...new Set(
    [...readFileSync(join(ROOT, 'apps', 'payment', 'templates', 'default.conf.template'), 'utf8')
      .matchAll(/\$\{(CORDEL_[A-Z_]+)\}/g)].map((m) => m[1]),
  ),
].sort();

const DEPLOYS = [
  { file: 'deploy-admin.yml', unit: 'fitness-admin', reads: () => runtimeEnvRead('admin'), extra: ['CLERK_SECRET_KEY'] },
  { file: 'deploy-member.yml', unit: 'fitness-members', reads: () => runtimeEnvRead('member'), extra: ['CLERK_SECRET_KEY'] },
  { file: 'deploy-payment.yml', unit: 'fitness-pay', reads: () => PAYMENT_TEMPLATE_VARS, extra: [] as string[] },
];

function heredoc(text: string): string {
  const start = text.indexOf('cat > "$ENV_TMP" <<ENVEOF');
  const end = text.indexOf('ENVEOF', start + 30);
  return start === -1 || end === -1 ? '' : text.slice(start, end);
}

describe.each(DEPLOYS)('$file writes its app’s environment from GitHub', ({ file, unit, reads, extra }) => {
  const text = workflow(file);
  const block = heredoc(text);

  it('finds the settings it is guarding', () => {
    // A rename that emptied the list would make this gate vacuous.
    expect(reads().length).toBeGreaterThan(0);
    expect(block).not.toBe('');
  });

  it('forwards every setting the app reads, through both steps', () => {
    for (const name of [...reads(), ...extra]) {
      expect(text, `${name} mapped from GitHub`).toMatch(new RegExp(`\\n\\s+${name}: \\$\\{\\{ (vars|secrets)\\.${name} \\}\\}`));
      expect(block, `${name} written into the unit`).toMatch(new RegExp(`^\\s*${name}=\\$\\{${name}(:-)?\\}$`, 'm'));
    }
  });

  it('deploys from the self-hosted runner, with no SSH and no secret inside the script', () => {
    expect(text).not.toContain('appleboy/ssh-action');
    expect(text).not.toMatch(/^\s*envs:/m);
    expect(text).not.toMatch(/SSH_/);
    expect(text).toMatch(/runs-on: \[self-hosted, corfront, /);
    const script = text.slice(text.indexOf('        run: |'));
    expect(script, 'secrets interpolated into the script body').not.toContain('secrets.');
  });

  it('rewrites the unit’s Environment= lines and reloads before the restart', () => {
    expect(text).toContain(`$HOME/.config/containers/systemd/${unit}.container`);
    expect(text).toContain("sed -i '/^Environment=/d' \"$UNIT\"");
    expect(text).toContain('sed -i "/^\\[Container\\]$/r $UNIT_ENV" "$UNIT"');
    expect(text).toContain("s/%/%%/g; s/^/Environment=/");
    const reload = text.indexOf('systemctl --user daemon-reload');
    const restart = text.indexOf(`systemctl --user restart ${unit}.service`);
    expect(reload).toBeGreaterThan(-1);
    expect(reload).toBeLessThan(restart);
  });

  it('checks before it touches the unit', () => {
    const rewrite = text.indexOf("sed -i '/^Environment=/d' \"$UNIT\"");
    // Required values present, and no key in the unit that would be dropped.
    expect(text.indexOf('is empty in GitHub env')).toBeLessThan(rewrite);
    expect(text.indexOf('sets variables this workflow does not manage')).toBeLessThan(rewrite);
  });

  it('no longer says the environment is the unit owner’s', () => {
    expect(text).not.toContain('Oscar owns the systemd unit (ports, env vars');
  });
});
