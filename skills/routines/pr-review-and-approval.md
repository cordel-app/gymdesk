Review pull requests in the cordel-app/gymdesk repository.

Identify the oldest open PR that targets the main branch.

Check for merge conflicts:
If there are no conflicts, proceed to the CI check below.
If there are conflicts, resolve them by pulling the latest main, merging main into the PR branch, pushing the resolution, then proceed to the CI check below.

Always check CI on the PR's head commit before merging — this is not optional:
- Wait for all checks to finish. Poll infrequently (every 2-3 minutes, not in tight loops) — CI takes minutes regardless, and frequent polling just burns tokens without speeding anything up.
- If CI is green, sanity-check the PR before merging: typecheck (`npx tsc --noEmit`) in any workspace touched, and skim the diff for anything that looks unfinished, unsafe, or out of scope. Start from the PR description and file list rather than pulling the full patch for every file — only fetch a specific file's diff if something in it looks questionable. If it looks safe, squash-merge the PR.
- If CI is red, investigate the actual failure (read the job logs, not just the status). Fetch a small tail (~100-150 lines) first, not the full log — the error is almost always right before the step fails, and post-failure cleanup output (git/docker teardown, etc.) is noise. If it's a genuine, fixable problem introduced by the PR itself (e.g. a wrong assertion, a missed edge case) — not a pre-existing failure on main, and not something that needs a design decision — fix it, push the fix to the PR's branch, and re-check CI. Repeat until CI is green or the failure can't be safely fixed this way.
- If CI is still red after a reasonable fix attempt, or the failure needs a judgment call outside the ticket's scope, do not merge — but do not stop the routine either, and never leave the question sitting only in a PR comment. Follow "Open questions never block the queue" below, then continue to the next-oldest open PR.

Open questions never block the queue:

A pull request is never left parked on an unanswered question. Whenever you hit something you can't settle on your own — a CI failure that needs a design decision, a security alert you believe is a false positive but can't dismiss, an ambiguity in the ticket's scope, anything you would otherwise have stopped and waited on — raise it as a normal ticket and move on, in this order:

1. **Create a GitHub issue** in cordel-app/gymdesk describing the question. Title it as the decision to be made, not as a status report. The body states what is blocked, the specific question, the options you see with their trade-offs, and your recommendation. Link the PR. This is the ticket that tracks the answer, so it must stand on its own for someone who hasn't read the PR thread.
2. **Comment on the PR**, briefly, linking that issue — a pointer, not a second copy of the analysis.
3. **Post to Slack** (#issues-open-questions, C0BMQT25DCP), the same way the issues routine posts its clarification questions: the question, the PR, and a link to the issue.
4. **Continue to the next-oldest open PR.** The blocked PR is now tracked by a ticket; it is not this routine's problem again until the ticket is answered.

Before raising a new ticket, check whether the same question is already filed — search open issues, and check whether a previous run already commented on this PR about it. If it is already tracked, do not file a duplicate, do not repeat the comment, and do not re-post to Slack; just continue to the next PR.

A green PR is never held back by an open question. If CI is green and the only thing holding the PR is a question or a doubt of yours, file the ticket as above and still merge it — raising the question does not make the PR unmergeable. What blocks a merge is a failing or pending check, and only that.

This repo has no separate reviewer identity — every PR is authored by the same account this task runs as, so GitHub will refuse a formal "approve" review (self-approval is blocked platform-wide). Don't attempt to approve; merging directly is the intended workflow here, but only once CI is actually green — never merge with a failing or pending check.

If there are no open PRs, confirm briefly.
