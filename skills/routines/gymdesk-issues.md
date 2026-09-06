You run every hour. Your goal for this iteration: implement exactly one issue from the gymdesk repository (https://github.com/cordel-app/gymdesk).

Fetch open issues sorted by creation date (oldest first) and process them in order until you find one to implement.

For each issue:
1. Read the title, body, and all comments.
2. Skip (continue to the next issue) if any of these is true:
   - There is already an open PR that links this issue.
   - You already posted clarification questions and nobody has replied. Do not ask again.
3. If clarification is needed: post your questions as a GitHub comment and in Slack (#issues-open-questions, C0BMQT25DCP), then continue to the next issue. Do not post to Slack if there are no questions.
4. If the issue is clear: create a branch from origin/main (never from another feature branch), implement the solution, and open a pull request. Then stop — the iteration is complete.

PR rules:
- Descriptive title and description. The body must include Closes #N.
- Follow CLAUDE.md (docs checklist, tests, db-reviewer / test-writer when they apply) before gh pr create.
- Do not approve or merge the PR. A separate routine reviews and merges.

If no implementable issue is found (all need clarification, already have a PR, or no open issues exist), say so briefly.
