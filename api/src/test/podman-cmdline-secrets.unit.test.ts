// #1192 — no workflow puts a value on podman's command line.
//
// journald records the command line of every process that logs to it in the
// `_CMDLINE` field, podman logs to it when it starts a container, and the
// hosts' log shipper sends whole journal entries to Grafana Cloud Loki. So a
// value passed as `--env KEY=value`, `-e KEY=value` or `mysql -p<password>`
// ends up readable in Loki. The API's inline `Environment=` lines and the
// migration's `-e DATABASE_URL=…` put every dev secret there until #1192.
//
// A value reaches a container through `-e NAME` (copied from the calling
// shell's environment) or an `--env-file`/`EnvironmentFile=` instead.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');
const sources = readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => ({ file, text: readFileSync(join(WORKFLOWS, file), 'utf8') }));

/** Every `podman run …` invocation, continuation lines joined, comments dropped. */
function podmanRuns(text: string): string[] {
  const lines = text.split('\n').filter((l) => !l.trim().startsWith('#'));
  const joined = lines.join('\n').replace(/\\\n\s*/g, ' ');
  return joined.split('\n').filter((l) => /\bpodman run\b/.test(l));
}

describe('podman is never handed a value on its command line', () => {
  it('passes no `-e/--env NAME=value` to podman run', () => {
    let runs = 0;
    for (const { file, text } of sources) {
      for (const run of podmanRuns(text)) {
        runs++;
        expect(run, `${file}: ${run.trim().slice(0, 120)}`).not.toMatch(/(?:^|\s)(?:-e|--env)[ =]+["']?[A-Za-z_][A-Za-z0-9_]*=/);
      }
    }
    expect(runs).toBeGreaterThan(3);
  });

  it('passes no password flag to a client inside podman run', () => {
    for (const { file, text } of sources) {
      for (const run of podmanRuns(text)) {
        expect(run, `${file}: ${run.trim().slice(0, 120)}`).not.toMatch(/\s-p["'$]/);
      }
    }
  });

  it('writes no inline Environment= value into a quadlet unit', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/^\s*Environment=[A-Za-z_][A-Za-z0-9_]*=/m);
    }
  });
});
