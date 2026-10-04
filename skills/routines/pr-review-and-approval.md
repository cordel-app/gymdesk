Review pull requests in the cordel-app/gymdesk repository.

Work the open PRs that target `main` **oldest first, as a loop** — not one PR and stop. Merging a PR, parking one, or finding one already merged or closed is the end of *that PR*, never of the run. Keep going until a full pass finds nothing left to work (see **The loop**).

## The loop

1. List the open PRs targeting `main`, oldest first.
2. Take the first one that is not skipped (parked with nothing changed since — see **Parking a PR**) and not already handled earlier in this run, and work it through the checks below until it is **merged** or **parked**.
3. Go back to step 1 and **list again**. Do not keep walking the list you fetched at the start: a merge moves `main`, PRs get opened, merged or changed under you, and a PR you parked earlier may have un-parked (see **After each merge**).
4. Stop only when a fresh list contains no PR you can work: none open, or every one is parked with nothing changed, or every remaining one was already handled in this run. Then report what you merged, what you parked and why.

A PR you cannot finish must not block the ones behind it: park it and move on. Do not stop after the first merge, and do not stop after the first park.

For each PR in turn, take the cheap checks first, before reading a diff or a log:

1. **Skip it** if it is parked and nothing has changed since — see **Parking a PR**.
2. **Ask whether the work is still wanted** — see **Is this PR still the work?**. A superseded PR is parked in minutes; investigating one costs hours.
3. **Check for merge conflicts.** None → go to the CI check. Conflicts → see **Resolving conflicts**.
4. **Check CI on the head commit.**

## Is this PR still the work?

Before investing in a PR, confirm it is still work the product wants. Two runs each spent hours on #994 — eighteen test merges, a CI log read, a test fixed — before either noticed that its ticket had **already landed** in #993 under an identical title, and that #998 had since landed the stage after it.

So look, cheaply: does `main` already carry a commit for this PR's ticket and stage? Does its branch conflict in *every single file it touches*, several of them add/add? Either is the signature of a second, independent implementation of finished work. Park it — a superseded PR is a human's call to close, never something to merge or to resolve file by file — and say in the comment what landed instead.

## Resolving conflicts

Resolve by fetching `main`, merging `main` into the PR branch, and pushing the resolution. The judgement is *which* conflicts you may resolve, and it is the line between the three PRs that merged today and the one that did not:

- **Mechanical** — each side changed a *different* thing and they merely sit near each other: both appended a sentence to the same long CLAUDE.md bullet, both added a row to the same table, one renamed a locale key while the other added a component on the adjacent line. Resolve these, keeping **both** sides' intent, and verify you did (grep for a phrase from each side in the merged file). This is most conflicts and it is the routine's job.
- **A design collision** — both sides changed *the same decision*: two implementations of one feature, two different shapes for one function, two answers to one question. Never pick a side. That is the "never blindly choose ours or theirs" case in `CLAUDE.md`, and it is a human's call about which design the product keeps. Park it.

A file-count alone does not tell the two apart: three PRs today conflicted in docs and `CLAUDE.md` and were purely mechanical. What tells them apart is whether both sides are *answering the same question*.

**Validate before pushing a resolution.** A resolution that breaks the build costs a full CI cycle and makes the PR look worse than it was. Typecheck (`npx tsc --noEmit`) and run the fast suites in every workspace the merge touched, then push. One validated push beats three speculative ones.

## Checking CI

- Wait for all checks to finish. Poll infrequently (every 2-3 minutes, not in tight loops) — CI takes minutes regardless, and frequent polling just burns tokens without speeding anything up.
- **No checks at all is not "pending".** A head commit whose check list is *empty* — `get_status` answering `state: pending` with `total_count: 0`, as #994's head did — has no CI coming, usually because the results aged out or the run never fired. Waiting for it never ends. A push (a resolution, a fix) is what brings CI back; if you have nothing to push, park it and say CI never ran.
- If CI is green, sanity-check the PR before merging: typecheck (`npx tsc --noEmit`) in any workspace touched, and skim the diff for anything that looks unfinished, unsafe, or out of scope. Start from the PR description and file list rather than pulling the full patch for every file — only fetch a specific file's diff if something in it looks questionable. If it looks safe, squash-merge the PR.
- If CI is red, investigate the actual failure (read the job logs, not just the status). Fetch a small tail (~100-150 lines) first, not the full log — the error is almost always right before the step fails, and post-failure cleanup output (git/docker teardown, etc.) is noise. If it's a genuine, fixable problem introduced by the PR itself (e.g. a wrong assertion, a missed edge case) — not a pre-existing failure on main, and not something that needs a design decision — fix it, push the fix to the PR's branch, and re-check CI. Repeat until CI is green or the failure can't be safely fixed this way.
- A failure is often in the PR's *fixture* rather than in the product: today a test asserting 201 got 422 because the case put two exercises in a block type that allows one, and another expected a forecast for an assignment whose test fixture gave it no price. Read what the code under test actually requires before concluding the product is wrong.
- If CI is still red after a reasonable fix attempt, or the failure needs a judgment call outside the ticket's scope, **park the PR** rather than stopping.

## After each merge, re-evaluate the rest of the queue

Merging moves `main`, so every conflict verdict and mergeability flag you read before it is stale. Re-check the remaining PRs against the new `main` rather than trusting an earlier result — and expect PRs to merge or change under you between your own reads.

The failure this prevents is invisible on the PR itself, because **a PR's CI is green against its own base**, not against what `main` becomes. The concrete case: three open PRs each added a migration numbered `207`. The first to merge took the number, and the other two were then carrying a duplicate — green on their own branches, broken once landed. Renumbering is mechanical and yours to do: rename the file to the next free number and move every reference to it (routers, tests, a unit test that reads the migration by filename, the docs and `CLAUDE.md` sentences that name it), leaving the other PR's references alone.

When two PRs' fixes interact like that, **merge the green one first** and renumber behind it, so the numbers land in order.

## Parking a PR

A PR you cannot merge is parked, never silently abandoned and never left blocking the queue. The symptom this replaces: one PR needing a human decision sat at the head of the queue for nine hours, and nothing behind it was looked at, because the routine commented and stopped.

To park:
1. Leave one comment explaining what is failing or what decision is needed, and what you tried.
2. Add the `needs-human` label (create it if the repository does not have it yet).
3. Move on to the next PR in the queue.

A parked PR is skipped on later runs **until something changes**, which is any one of:
- a commit pushed to its head branch after the parking comment;
- a comment by someone other than this account, after the parking comment;
- CI green on its current head;
- `main` having moved since the parking, *when the parking reason was a failure the PR did not cause* — a base-branch problem or a collision with another PR can simply be gone.

Any of those un-parks it: remove the `needs-human` label and work it normally. Without them a parked PR would be parked for ever, which is the same failure one layer up.

**Do not re-post an equivalent comment.** If the PR is already parked and your assessment has not changed, say nothing — the comment is already there. Two iterations once posted near-identical stand-down analyses four hours apart on the same PR; the second one re-ran every test and re-read every log to reach the conclusion already written above it. Comment again only when you have something new: a different failure, a diagnosis that moved, or a fix you pushed.

## Before any write, re-read the state

Resolving conflicts and waiting for CI take minutes, and a second iteration of this routine can be working the same PR in that window — or you may have been handed the queue while somebody merged by hand. So immediately before each comment, push or merge, re-read the PR: it may already be merged, closed, parked or moved on.

- Pass `expectedHeadSha` on every merge, so a merge is refused rather than landing on a head you have not checked.
- A rejected non-fast-forward push means somebody else resolved it first: re-fetch and look before pushing again, don't force.
- A PR that merged while you were working on it is not an error. Note it and move to the next one.

## Practical notes

- This is an npm workspaces repo, so installing in one workspace prunes another's `node_modules`: a `npm ci` inside `apps/admin` leaves `api`'s `dotenv` unresolvable and vice versa. Install once from the repository root when you need both, or you will read a missing-module error as a broken typecheck.
- The DB-backed API suites need the MySQL service container. If the environment has no Docker daemon, say so plainly rather than reporting the suite as passing — CI is then the first real run of those tests.

This repo has no separate reviewer identity — every PR is authored by the same account this task runs as, so GitHub will refuse a formal "approve" review (self-approval is blocked platform-wide). Don't attempt to approve; merging directly is the intended workflow here, but only once CI is actually green — never merge with a failing or pending check.

When the loop ends, summarise the run briefly: the PRs merged, the PRs parked (with the reason), and the PRs skipped as already parked. If there were no open PRs, or every one of them is parked with nothing changed since, just confirm that.
