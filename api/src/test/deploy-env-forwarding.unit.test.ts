// #1177 — `deploy.yml` is the only writer of the API's environment.
//
// Its deploy script deletes every `Environment=` line of the `fitness-api`
// quadlet and writes its own GitHub-sourced block, so a setting the API reads
// that `deploy.yml` does not forward cannot be set at all: a value written by
// hand on the VPS is gone after the next deploy, and nothing fails — the API
// falls back to a default. That is how the proxy-hop counts never took effect
// and how #1113's reminder run answered 401 on every pass.
//
// This gate derives the names from the code, so a new relay hop or a new
// internal-run secret cannot be added without being forwarded.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(__dirname, '..');
const DEPLOY = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const FORWARDED_CLIENT = readFileSync(join(SRC, 'domain', 'forwardedClient.ts'), 'utf8');

function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : productionSources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Every proxy-hop setting `forwardedClient.ts` reads. */
const HOP_SETTINGS = [...new Set([...FORWARDED_CLIENT.matchAll(/\benv\.([A-Z_]+_HOPS)\b/g)].map((m) => m[1]))].sort();

/** Every internal-run secret any production source reads. */
const INTERNAL_SECRETS = [
  ...new Set(
    productionSources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z_]+_INTERNAL_SECRET)\b/g)].map((m) => m[1]),
    ),
  ),
].sort();

function expectForwarded(name: string, source: 'vars' | 'secrets') {
  // 1. Mapped from the GitHub environment into the step.
  expect(DEPLOY, `${name} mapped from ${source}`).toContain(`${name}: \${{ ${source}.${name} }}`);
  // 2. Passed over SSH.
  expect(DEPLOY, `${name} in envs:`).toMatch(new RegExp(`envs: [^\\n]*\\b${name}\\b`));
  // 3. Written into the unit.
  expect(DEPLOY, `${name} written as Environment=`).toMatch(
    new RegExp(`Environment=${name}=\\$\\{${name}(:-)?\\}`),
  );
}

describe('the settings the API reads are the settings deploy.yml writes', () => {
  it('finds the hop settings and internal secrets it is guarding', () => {
    // A rename that made either list empty would make this gate vacuous.
    expect(HOP_SETTINGS).toEqual(expect.arrayContaining([
      'TRUST_PROXY_HOPS',
      'PAYMENT_WEBHOOK_RELAY_HOPS',
      'INTERNAL_RUN_RELAY_HOPS',
    ]));
    expect(INTERNAL_SECRETS).toEqual(expect.arrayContaining([
      'BILLING_INTERNAL_SECRET',
      'RECURRING_BOOKINGS_INTERNAL_SECRET',
      'BOOKING_REMINDERS_INTERNAL_SECRET',
    ]));
  });

  it('forwards every proxy-hop setting from a GitHub variable', () => {
    for (const name of HOP_SETTINGS) expectForwarded(name, 'vars');
  });

  it('forwards every internal-run secret from a GitHub secret', () => {
    for (const name of INTERNAL_SECRETS) expectForwarded(name, 'secrets');
  });

  it('still replaces the unit’s whole environment, which is why the above matters', () => {
    // If this ever stops being true, a hand-set value would survive and the
    // gate's premise should be revisited rather than silently kept.
    expect(DEPLOY).toContain("sed -i '/^Environment=/d; /^EnvironmentFile=/d' \"$CF\"");
  });
});
