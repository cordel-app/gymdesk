// A self-hosted runner executes whatever the workflow tells it to, on a VPS that
// holds the deploy credentials. A workflow triggered by a pull request runs code
// from the PR's branch (and, for `pull_request_target`, with the base repo's
// secrets), so letting one reach a self-hosted runner hands the VPS to anyone who
// can open a PR. Deploy jobs may use `self-hosted`; a PR-triggered workflow never.
//
// The check is textual on purpose (no YAML parser in the API's dependencies) and
// errs on the side of failing: in a PR-triggered workflow, any non-comment line
// mentioning `self-hosted` is a violation, not only a `runs-on` line.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');

const stripComments = (text: string) =>
  text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

/** The text of the top-level `on:` key: inline value plus its indented block. */
function triggerBlock(text: string): string {
  const lines = stripComments(text).split('\n');
  const start = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (start === -1) return '';
  const block = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && !/^\s/.test(l)) break;
    block.push(l);
  }
  return block.join('\n');
}

export function triggeredByPullRequest(text: string): boolean {
  return /\bpull_request(_target)?\b/.test(triggerBlock(text));
}

export function selfHostedLines(text: string): string[] {
  return stripComments(text)
    .split('\n')
    .filter((l) => /self-hosted/.test(l))
    .map((l) => l.trim());
}

/** Returns the offending lines, or [] when the workflow is allowed. */
export function selfHostedOnPullRequest(text: string): string[] {
  return triggeredByPullRequest(text) ? selfHostedLines(text) : [];
}

describe('no self-hosted runner in a pull-request workflow', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it('finds the workflows', () => {
    expect(files).toContain('ci.yml');
  });

  it.each(files)('%s', (file) => {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    expect(selfHostedOnPullRequest(text)).toEqual([]);
  });

  it('ci.yml is recognised as pull-request triggered, so the guard really covers it', () => {
    expect(triggeredByPullRequest(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8'))).toBe(true);
  });

  describe('the detector itself', () => {
    const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');

    it('fails when self-hosted is added to ci.yml', () => {
      const tampered = ci.replace(/runs-on:\s*.+/, 'runs-on: [self-hosted, corback, dev]');
      expect(tampered).not.toBe(ci);
      expect(selfHostedOnPullRequest(tampered).length).toBeGreaterThan(0);
    });

    it('catches pull_request_target and the inline and list trigger forms', () => {
      const job = 'jobs:\n  a:\n    runs-on: [self-hosted]\n';
      for (const on of [
        'on:\n  pull_request_target:\n    types: [opened]\n',
        'on: pull_request\n',
        'on: [push, pull_request]\n',
        'on:\n  push:\n  pull_request:\n',
      ]) {
        expect(selfHostedOnPullRequest(on + job), on).toHaveLength(1);
      }
    });

    it('allows a deploy workflow that no pull request can trigger', () => {
      const deploy =
        'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: [self-hosted, corback, dev]\n';
      expect(selfHostedOnPullRequest(deploy)).toEqual([]);
    });

    it('ignores a self-hosted mention inside a comment', () => {
      const wf = 'on:\n  pull_request:\njobs:\n  a:\n    runs-on: ubuntu-24.04 # never self-hosted here\n';
      expect(selfHostedOnPullRequest(wf)).toEqual([]);
    });
  });
});
