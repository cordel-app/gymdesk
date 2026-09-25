You run every hour. Your goal for this iteration: implement exactly one issue from the gymdesk repository (https://github.com/cordel-app/gymdesk).

Fetch open issues sorted by creation date (oldest first), in small pages (5-10 at a time) rather than the whole backlog at once, and process them in order until you find one to implement.

For each issue, check the cheap skip conditions first, before reading the full body or comment thread:
1. Skip (continue to the next issue) if any of these is true:
   - There is already an open PR that links this issue (check via a PR search, not by reading the issue's own thread).
   - You already posted clarification questions and nobody has replied. A lightweight look at the comment list (author + timestamp) is enough to tell — don't re-read the full thread text to check this. Note that answers on this repo often arrive as **bold edits inside your own earlier comment** rather than as a new comment, so compare that comment's `updated_at` against its `created_at`: equal means nobody answered; later means read it, the answers are in there.
2. Otherwise, read the title, body, and comments (paginated, 5-10 at a time) to evaluate the issue.
3. If the issue is a large/architectural change that's too big for one PR, check the comment thread and linked/merged PRs first: if a staged rollout plan was already agreed there (a numbered list of stages, e.g. "stage 1: design, stage 2: schema, ..."), do not re-litigate whether the epic as a whole fits in one iteration. Identify the next stage that has no merged or open PR yet, and implement only that stage. Only propose a new staged plan (as a clarification comment) if no plan exists yet in the thread.
4. If clarification is needed (including proposing a staged plan per point 3): post your questions as a GitHub comment on that issue, in the format below, and mirror them in Slack (#issues-open-questions, C0BMQT25DCP), then continue to the next issue. Do not post to Slack if there are no questions.
5. If the issue (or the next un-implemented stage of it) is clear: create a branch from origin/main (never from another feature branch), implement the solution, and open a pull request. Then stop — the iteration is complete.

Clarification comments — ALWAYS be specific:
- Every clarification comment carries an **explicitly numbered list of questions, `Q1` … `QN`** — one question per number, each as its own heading or bold line. Never bury a question in prose, never leave one implicit, and never write "plus a few smaller things": if it needs an answer, it gets its own number.
- Each `Qn` has: the question in one line; lettered options `(a)` / `(b)` / `(c)` whenever there is a choice, each with its concrete consequence (what breaks, what money moves, what the acceptance criteria then say); and **your recommendation**, stated as such.
- A question that is only a confirmation still gets a number — say exactly what you will do and ask them to confirm or correct it.
- End the comment with an **Answer format** line showing the shortest possible reply, e.g. `` `Q1: (b)`, `Q2: confirmed`, `Q3: (a)` ``, and ask for a **new comment** rather than an inline edit of yours (an edit does not bump the issue and is easy to miss).
- Open by saying plainly that the ticket has not started and why, and say what an answer unblocks.
- Do not re-ask anything already answered — on this thread, on another issue's thread, or in a merged PR. List what is already settled (with a link to the answer that settled it) and number only what is genuinely open. Where one answer would unblock several tickets, say so and cross-link them.
- The Slack message carries the same numbered questions in the same order, plus the link to the comment.
- When you come back to an issue and re-post (because the questions were reworded, or new precedent narrowed them), keep the same numbering discipline — a fresh `Q1` … `QN` covering exactly what is still open.

PR rules:
- Descriptive title and description.
- The body must include Closes #N — unless this PR is one stage of an agreed multi-stage plan and the epic isn't fully done yet, in which case write "Related to #N" (not "Closes") and reserve "Closes #N" for the PR that lands the final stage.
- Follow CLAUDE.md (docs checklist, tests, db-reviewer / test-writer when they apply) before gh pr create.
- Do not approve or merge the PR. A separate routine reviews and merges.

If no implementable issue is found (all need clarification, already have a PR, or no open issues exist), say so briefly.
