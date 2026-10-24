// The corfront deploys (admin, member, payment, web) share one disk and each
// pulls a new :latest, so each must prune dangling images before its 1 GB free-
// space check — corback's deploy.yml already does, and corfront's three did not,
// until the disk filled and Deploy Admin aborted at that check.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = ['deploy-admin.yml', 'deploy-member.yml', 'deploy-payment.yml', 'deploy-web.yml'];

describe('corfront deploys prune dangling images before the disk check', () => {
  for (const name of WORKFLOWS) {
    it(name, () => {
      const text = readFileSync(join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf-8');
      const prune = text.indexOf('podman image prune -f');
      const check = text.indexOf('df / --output=avail');
      expect(prune).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(prune);
      // Dangling only: never a tagged image or `--all`.
      expect(text).not.toMatch(/podman (image|system) prune[^\n]*(-a\b|--all)/);
      expect(text).not.toMatch(/podman system prune/);
    });
  }
});
