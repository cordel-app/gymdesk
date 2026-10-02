You run every hour. Your goal for this iteration: implement exactly one issue from the gymdesk repository (https://github.com/cordel-app/gymdesk).

Fetch open issues sorted by creation date (oldest first), in small pages (5-10 at a time) rather than the whole backlog at once, and process them in order until you find one to implement.

For each issue, check the cheap skip conditions first, before reading the full body or comment thread:
1. Skip (continue to the next issue) if any of these is true:
   - There is already an open PR that links this issue (check via a PR search, not by reading the issue's own thread).
   - You already posted clarification questions and nobody has replied. A lightweight look at the comment list (author + timestamp) is enough to tell — don't re-read the full thread text to check this.
   - The work is already claimed by another iteration — see **Claiming the work** below. For a multi-stage epic this is per stage, so a claim on stage 4 must not stop you implementing stage 5.
2. Otherwise, read the title, body, and comments (paginated, 5-10 at a time) to evaluate the issue.
3. If the issue is a large/architectural change that's too big for one PR, check the comment thread and linked/merged PRs first: if a staged rollout plan was already agreed there (a numbered list of stages, e.g. "stage 1: design, stage 2: schema, ..."), do not re-litigate whether the epic as a whole fits in one iteration. Identify the next stage that has no merged or open PR yet, and implement only that stage. Only propose a new staged plan (as a clarification comment) if no plan exists yet in the thread.
4. If clarification is needed (including proposing a staged plan per point 3): post your questions as a GitHub comment and in Slack (#issues-open-questions, C0BMQT25DCP), then continue to the next issue. Do not post to Slack if there are no questions.
5. If the issue (or the next un-implemented stage of it) is clear: **claim it first** (below), then implement the solution on the claimed branch and open a pull request. Then stop — the iteration is complete.

## Claiming the work

Two iterations of this routine can overlap: implementing an issue takes longer than the hour between runs, so a second run can start while the first is still working. "Is there an open PR for this issue?" does not protect against that — the PR only exists at the *end* of a run, so both runs check before either has opened one and both proceed. That is how #924 stage 4 came to be implemented twice, in #993 and #994: two sessions 17 minutes apart, the same design, 18 files of unmergeable duplicate work, and one of the two thrown away.

So claim the work **before** implementing it, never after. The claim is a branch whose name is derived from what you are about to implement, plus a comment that makes it visible:

- **The branch name is deterministic**, never the session's own generated name: `claude/issue-<N>` for a whole issue, `claude/issue-<N>-stage-<S>` for one stage of a staged plan. Two runs that pick the same work therefore pick the same name, which is what turns the race into a cheap collision instead of duplicated work.
- **Create that branch ref before doing anything else**, at `origin/main`'s current commit, through the GitHub API (create a reference) rather than a local `git push`. Creating a ref that exists answers `422 Reference already exists`, atomically; pushing the same commit to an existing branch succeeds silently and protects nothing.
- **If the ref already exists**, the work is claimed: skip this issue (or this stage) and continue to the next, unless the claim is stale per the rule below.
- **Then post a one-line claim comment** on the issue naming what you are implementing and the branch, e.g. `Implementing stage 4 on claude/issue-924-stage-4.` It is what tells a human reading the thread that the work is in flight, and its timestamp is what makes the claim reclaimable.
- **Then implement on that branch** and open the PR from it. Do not create a second branch, and do not rename it — the name is the lock.

### Releasing and reclaiming

A claim that is never released would block the work for ever, so:

- **If you stop before opening a PR** — the issue turns out to need clarification after all, or you cannot finish — delete the branch you created and say so in a comment, so the next iteration can take the work.
- **A claim is stale** when the branch exists, no open PR links the issue, and the claim comment for that same unit of work is more than **3 hours** old. A run is expected to finish well inside that. Treat a stale claim as abandoned: take the work over on that same branch (reuse the ref, don't delete and recreate it — a fresh ref would race with whatever may still be running), and say in a comment that you are doing so.
- **A branch with commits on it but no PR** is not automatically stale: look at it before assuming. If its work is sound, finish it and open the PR; if it is unusable, say so in a comment before replacing it.

Never resolve a collision by implementing the work anyway under a different branch name. Two implementations of one unit of work cannot be merged — they conflict in every file either touched, add/add on every file both created — so the second one is thrown away whatever its quality. Skipping costs an iteration; duplicating costs a day's work and a judgment call about which design the product keeps.

PR rules:
- Descriptive title and description.
- The body must include Closes #N — unless this PR is one stage of an agreed multi-stage plan and the epic isn't fully done yet, in which case write "Related to #N" (not "Closes") and reserve "Closes #N" for the PR that lands the final stage.
- Open it from the claimed branch (`claude/issue-<N>` or `claude/issue-<N>-stage-<S>`).
- Follow CLAUDE.md (docs checklist, tests, db-reviewer / test-writer when they apply) before gh pr create.
- Do not approve or merge the PR. A separate routine reviews and merges.

If no implementable issue is found (all need clarification, already have a PR, are claimed by a live iteration, or no open issues exist), say so briefly.
