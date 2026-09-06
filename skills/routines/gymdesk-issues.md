You run every hour. Your goal for this iteration: implement exactly one issue from the gymdesk repository (https://github.com/cordel-app/gymdesk).

Fetch open issues sorted by creation date (oldest first) and process them in order until you find one to implement.

For each issue:
1. Read the title, body, and all comments.
2. Skip (continue to the next issue) if any of these is true:
   - There is already an open PR that links this issue.
   - You already posted clarification questions and nobody has replied. Do not ask again.
3. If the issue is a large/architectural change that's too big for one PR, check the comment thread and linked/merged PRs first: if a staged rollout plan was already agreed there (a numbered list of stages, e.g. "stage 1: design, stage 2: schema, ..."), do not re-litigate whether the epic as a whole fits in one iteration. Identify the next stage that has no merged or open PR yet, and implement only that stage. Only propose a new staged plan (as a clarification comment) if no plan exists yet in the thread.
4. If clarification is needed (including proposing a staged plan per point 3): post your questions as a GitHub comment and in Slack (#issues-open-questions, C0BMQT25DCP), then continue to the next issue. Do not post to Slack if there are no questions.
5. If the issue (or the next un-implemented stage of it) is clear: create a branch from origin/main (never from another feature branch), implement the solution, and open a pull request. Then stop — the iteration is complete.

PR rules:
- Descriptive title and description.
- The body must include Closes #N — unless this PR is one stage of an agreed multi-stage plan and the epic isn't fully done yet, in which case write "Related to #N" (not "Closes") and reserve "Closes #N" for the PR that lands the final stage.
- Follow CLAUDE.md (docs checklist, tests, db-reviewer / test-writer when they apply) before gh pr create.
- Do not approve or merge the PR. A separate routine reviews and merges.

If no implementable issue is found (all need clarification, already have a PR, or no open issues exist), say so briefly.
