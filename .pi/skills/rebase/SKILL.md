---
name: rebase
description: Interactive rebase workflow. Detects the current branch situation, shows PR status and conflicts, and guides through the rebase process with conflict resolution.
---

# Rebase

Interactive rebase workflow with automatic situation detection, PR awareness, and conflict resolution.

## Input

The user may provide:
- **No arguments**: Auto-detect the current situation (see flow below).
- **Branch name**: Rebase that specific branch against its base.
- **PR number**: Rebase the branch of that PR against its base (e.g., `/rebase #42`).
- **`--onto <target>`**: Override the base branch.
- **Repo name**: If working from the agent directory, specify which repo.

## Repo Location

Repos are located at the path specified in `.pi/local.json` (`reposPath`), or check `project.yml` for configured repos, or use the current working directory as fallback.

## Flow (No Arguments)

### Step 1: Determine the Repo

1. If there's an obvious repo from conversation context, use it.
2. Otherwise, ask:
   > Which repo do you want to rebase in?

Navigate to the repo directory.

### Step 2: Fetch and Scan

```bash
git fetch origin
git branch --show-current
git status --porcelain
```

Record:
- `current_branch`: The branch we're on.
- `has_uncommitted`: Whether there are uncommitted changes.

### Step 3: Branch-Dependent Detection

#### If on `main` or `master` → List open PRs

```bash
gh pr list --json number,title,headRefName,baseRefName,mergeStateStatus --template '{{range .}}#{{.number}} {{.headRefName}} → {{.baseRefName}} ({{.mergeStateStatus}}){{"\n"}}{{end}}'
```

Present the list with status indicators:

```
You're on `main`. Here are your open PRs:

1. #42 `feature/user-auth` → base: `main` (⚠️ conflicts)
2. #38 `fix/login-bug` → base: `main` (✅ clean, 8 commits behind)
3. #45 `feature/dashboard` → base: `feature/user-auth` (✅ up to date)

Which one do you want to rebase? (number or branch name)
```

Wait for user selection, then proceed to Step 4.

#### If on a feature branch → Detect its PR and base

```bash
gh pr view --json number,title,baseRefName,mergeStateStatus,headRefName 2>/dev/null
```

**If the branch has an open PR**, show diagnostic and ask for confirmation.
**If no open PR**, assume rebase against main and ask for confirmation.

### Step 4: Pre-Rebase Checks

#### 4a. Handle uncommitted changes
If `has_uncommitted` is true, stash with a timestamped message.

#### 4b. Checkout the target branch (if not already on it)

#### 4c. Update base branch reference
```bash
git fetch origin <base-branch>
```

#### 4d. Show impact preview
```bash
git log --oneline HEAD..origin/<base-branch>
```

Wait for confirmation.

### Step 5: Execute Rebase

```bash
git rebase origin/<base-branch>
```

#### If rebase succeeds: Proceed to Step 6.

#### If rebase has conflicts:

For each conflict:
1. Show conflicted files and conflict markers.
2. Read the conflicted sections and propose a resolution based on codebase understanding (from memory files).
3. Present the proposed resolution and wait for approval.
4. Apply the fix and mark as resolved:
   ```bash
   git add <file>
   ```
5. Continue:
   ```bash
   GIT_EDITOR="true" git rebase --continue
   ```
6. If the user wants to abort:
   ```bash
   git rebase --abort
   ```

### Step 6: Post-Rebase Verification

#### 6a. Check for unnecessary blank lines
Rebases often introduce extra blank lines. Scan changed files and fix any issues.

#### 6b. Run Linter
Use the linter command from `project.yml` (`conventions.linter`) if configured.

#### 6c. Run Tests
Use the test command from `project.yml` (`conventions.test_command`). Focus on specs related to changed files.

#### 6d. Present Results

```
✅ Rebase completed successfully

- Branch: `feature/user-auth`
- Rebased against: `origin/main`
- Commits incorporated: 8
- Conflicts resolved: 2

Post-rebase verification:
- Blank lines cleanup: ✅ clean / 🧹 fixed N files
- Linter: ✅ passed / ❌ N offenses remaining
- Tests: ✅ all passing / ❌ N failures

Would you like to:
1. Force push? (`git push --force-with-lease`)
2. Check the PR status?
```

Do not suggest force pushing with failing tests unless the user explicitly asks.

### Step 7: Restore stash (if applicable)

## Flow (With Branch Name)
1. Navigate to the repo.
2. `git fetch origin`
3. Checkout the branch if not already on it.
4. Detect if it has a PR → use PR's base branch.
5. If no PR → use `main`/`master` as base.
6. Continue from Step 4.

## Flow (With PR Number)
1. Navigate to the repo.
2. Fetch PR details via `gh pr view`.
3. Checkout the PR's head branch.
4. Use the PR's base branch as the rebase target.
5. Continue from Step 4.

## Flow (With `--onto`)
1. Override whatever base branch was detected.
2. Useful for re-targeting a PR.

## Important Rules

- **Always ask before force pushing.** Never force push automatically.
- **Always show conflicts to the user.** Don't silently resolve them.
- **Use `--force-with-lease`**, never `--force`.
- **Use `GIT_EDITOR="true"`** for `git rebase --continue` to avoid vim blocking.
- **Stash safety**: Always restore stash at the end, even if the rebase was aborted.
- **Abort on request**: If the user says "abort" or "cancel", run `git rebase --abort` and restore stash.
- **Memory context**: Load repo context (`load_repo_context`) when resolving complex conflicts.
