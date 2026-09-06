Review pull requests in the cordel-app/gymdesk repository.

Identify the oldest open PR that targets the main branch.
Check for merge conflicts:
If there are no conflicts, squash-merge the PR directly.
If there are conflicts, resolve them by pulling the latest main, merging main into the PR branch, pushing the resolution, then squash-merge the PR.
This repo has no separate reviewer identity — every PR is authored by the same account this task runs as, so GitHub will refuse a formal "approve" review (self-approval is blocked platform-wide). Don't attempt to approve; merging directly is the intended workflow here.
Before merging, sanity-check the PR is safe to merge as-is: typecheck (npx tsc --noEmit) in any workspace touched, and skim the diff for anything that looks unfinished, unsafe, or out of scope. If something looks wrong, don't merge — leave a PR comment explaining why and stop.
If there are no open PRs, confirm briefly.
