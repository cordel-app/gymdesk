Review pull requests in the cordel-app/gymdesk repository.

Work the open PRs that target `main` **oldest first, as a queue** — not one PR and stop. A PR you cannot finish must not block the ones behind it: when you park one (below), move on to the next and keep going until the queue is empty or you have merged something.

For each PR in turn:

**Skip it** if it is parked and nothing has changed since — see **Parking a PR** below. This check is cheap (one label, one comment timestamp), so do it before reading the diff or the logs.

**Check for merge conflicts:**
If there are no conflicts, proceed to the CI check below.
If there are conflicts, resolve them by pulling the latest main, merging main into the PR branch, pushing the resolution, then proceed to the CI check below.

**Always check CI on the PR's head commit before merging — this is not optional:**
- Wait for all checks to finish. Poll infrequently (every 2-3 minutes, not in tight loops) — CI takes minutes regardless, and frequent polling just burns tokens without speeding anything up.
- If CI is green, sanity-check the PR before merging: typecheck (`npx tsc --noEmit`) in any workspace touched, and skim the diff for anything that looks unfinished, unsafe, or out of scope. Start from the PR description and file list rather than pulling the full patch for every file — only fetch a specific file's diff if something in it looks questionable. If it looks safe, squash-merge the PR.
- If CI is red, investigate the actual failure (read the job logs, not just the status). Fetch a small tail (~100-150 lines) first, not the full log — the error is almost always right before the step fails, and post-failure cleanup output (git/docker teardown, etc.) is noise. If it's a genuine, fixable problem introduced by the PR itself (e.g. a wrong assertion, a missed edge case) — not a pre-existing failure on main, and not something that needs a design decision — fix it, push the fix to the PR's branch, and re-check CI. Repeat until CI is green or the failure can't be safely fixed this way.
- If CI is still red after a reasonable fix attempt, or the failure needs a judgment call outside the ticket's scope, **park the PR** rather than stopping.

## Parking a PR

A PR you cannot merge is parked, never silently abandoned and never left blocking the queue. The symptom this replaces: one PR needing a human decision sat at the head of the queue for nine hours, and nothing behind it was looked at, because the routine commented and stopped.

To park:
1. Leave one comment explaining what is failing or what decision is needed, and what you tried.
2. Add the `needs-human` label (create it if the repository does not have it yet).
3. Move on to the next PR in the queue.

A parked PR is skipped on later runs **until something changes**, which is any one of:
- a commit pushed to its head branch after the parking comment;
- a comment by someone other than this account, after the parking comment;
- CI green on its current head.

Any of those three un-parks it: remove the `needs-human` label and work it normally. Without them a parked PR would be parked for ever, which is the same failure one layer up.

**Do not re-post an equivalent comment.** If the PR is already parked and your assessment has not changed, say nothing — the comment is already there. Two iterations once posted near-identical stand-down analyses four hours apart on the same PR; the second one re-ran every test and re-read every log to reach the conclusion already written above it. Comment again only when you have something new: a different failure, a diagnosis that moved, or a fix you pushed.

## Before any write, re-read the state

Resolving conflicts and waiting for CI take minutes, and a second iteration of this routine can be working the same PR in that window — or you may have been handed the queue while somebody merged by hand. So immediately before each comment, push or merge, re-read the PR: it may already be merged, closed, parked or moved on.

- Pass `expectedHeadSha` on every merge, so a merge is refused rather than landing on a head you have not checked.
- A rejected non-fast-forward push means somebody else resolved it first: re-fetch and look before pushing again, don't force.
- A PR that merged while you were working on it is not an error. Note it and move to the next one.

This repo has no separate reviewer identity — every PR is authored by the same account this task runs as, so GitHub will refuse a formal "approve" review (self-approval is blocked platform-wide). Don't attempt to approve; merging directly is the intended workflow here, but only once CI is actually green — never merge with a failing or pending check.

If there are no open PRs, or every one of them is parked with nothing changed since, confirm briefly.
