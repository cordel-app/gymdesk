# Finish feature

You are finalizing the current feature branch. Follow every step in order. Do NOT push, open a PR, merge into main, delete the branch, or delete the worktree — those actions are reserved for the human.

---

## Step 1 — Confirm you are on a feature branch

Run `git branch --show-current`. If the result is `main`, stop and tell the user. Do not proceed on `main`.

## Step 2 — Check working tree state

Run `git status`. Note any uncommitted changes. If there are uncommitted changes that are part of the feature, commit them now with an appropriate message before continuing.

## Step 3 — Fetch latest remote state

```bash
git fetch origin
```

## Step 4 — Merge origin/main into the current branch

```bash
git merge origin/main
```

Use `git merge`, not `git rebase`.

## Step 5 — Resolve conflicts if any

If the merge produces conflicts:

- Stop and inspect every conflicting file carefully.
- Preserve valid changes from **both** the feature branch and `origin/main`.
- Never blindly choose "ours" or "theirs" — understand what each side changed and why.
- Pay **special attention to `docs/roadmap.md`**: it is frequently modified by parallel agents. Do not remove another agent's entries. Keep both sets of changes, merging the sections manually. When in doubt, keep more, not less.
- After resolving, stage the files and complete the merge commit.

## Step 6 — Run tests

If a new router was added or modified, run:

```bash
cd api && npm test
```

If only frontend changes were made and no API test applies, note that explicitly. Do not skip this step silently.

## Step 7 — Check working tree is clean

Run `git status`. The working tree must be clean (no uncommitted changes, no unresolved conflicts) before the feature can be considered complete.

## Step 8 — Confirm branch contains origin/main

Run:

```bash
git log --oneline origin/main..HEAD
```

This lists commits on the feature branch that are not yet in `origin/main`. If the merge in step 4 succeeded, there should be no commits from `origin/main` missing in the feature branch.

Also verify:

```bash
git log --oneline HEAD..origin/main
```

This should be empty (zero lines), confirming the feature branch is fully up to date with `origin/main`.

## Step 9 — Report summary

Print a concise summary using this exact structure:

```
## /finish-feature summary

- Branch: <branch-name>
- Merged origin/main: yes / no (already up to date)
- Conflicts: yes (<list of files>) / no
- Tests: passed / skipped (reason) / failed (details)
- Working tree: clean / dirty (list uncommitted files)
- Ready to PR: yes / no (reason)
```

If anything is not green, explain what needs to be fixed before opening the PR.
