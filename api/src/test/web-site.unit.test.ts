// cordel.tech is a static nginx image on corfront (host :8084 -> container :80).
// The port mapping lives in Oscar's quadlet, so the reference copy and the
// workflow's health check are what keep it from drifting.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('web site deploy', () => {
  it('publishes host 8084 to container 80 and the image listens on 80', () => {
    expect(read('infra/web/cordel-web.container')).toMatch(/^PublishPort=8084:80$/m);
    expect(read('apps/web/Dockerfile')).toMatch(/^EXPOSE 80$/m);
    expect(read('apps/web/nginx.conf')).toMatch(/listen 80;/);
  });

  it('health-checks the port the unit publishes, over IPv4', () => {
    const wf = read('.github/workflows/deploy-web.yml');
    expect(wf).toContain('http://127.0.0.1:8084/');
    expect(wf).not.toContain('localhost:8084');
  });

  it('keeps the legal pages public but out of search results', () => {
    const conf = read('apps/web/nginx.conf');
    expect(conf).toMatch(/X-Robots-Tag "noindex, nofollow"/);
    for (const page of ['legal', 'terms', 'privacy']) {
      expect(read(`apps/web/${page}.html`)).toContain('noindex');
      expect(read('apps/web/index.html')).toContain(`href="/${page}"`);
    }
    expect(read('apps/web/index.html')).not.toContain('noindex');
  });
});
