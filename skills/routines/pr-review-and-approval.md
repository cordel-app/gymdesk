Review pull requests in the cordel-app/gymdesk repository.

Identify the oldest open PR that targets the main branch.

Check for merge conflicts:
If there are no conflicts, proceed to the CI check below.
If there are conflicts, resolve them by pulling the latest main, merging main into the PR branch, pushing the resolution, then proceed to the CI check below.

Always check CI on the PR's head commit before merging — this is not optional:
- Wait for all checks to finish.
- If CI is green, sanity-check the PR before merging: typecheck (`npx tsc --noEmit`) in any workspace touched, and skim the diff for anything that looks unfinished, unsafe, or out of scope. If it looks safe, squash-merge the PR.
- If CI is red, investigate the actual failure (read the job logs, not just the status). If it's a genuine, fixable problem introduced by the PR itself (e.g. a wrong assertion, a missed edge case) — not a pre-existing failure on main, and not something that needs a design decision — fix it, push the fix to the PR's branch, and re-check CI. Repeat until CI is green or the failure can't be safely fixed this way.
- If CI is still red after a reasonable fix attempt, or the failure needs a judgment call outside the ticket's scope, do not merge — leave a PR comment explaining what's failing and why, and stop.

This repo has no separate reviewer identity — every PR is authored by the same account this task runs as, so GitHub will refuse a formal "approve" review (self-approval is blocked platform-wide). Don't attempt to approve; merging directly is the intended workflow here, but only once CI is actually green — never merge with a failing or pending check.

If there are no open PRs, confirm briefly.
