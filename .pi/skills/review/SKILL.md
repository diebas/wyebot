---
name: review
description: Code review workflow. Asks for a PR number/URL or Jira ticket ID, then performs a thorough code review with actionable feedback.
---

# Code Review

Perform a thorough code review on a pull request or the changes associated with a Jira ticket.

## Input Required

**Always ask the user before proceeding.** Present these options:

> What would you like me to review?
>
> 1. **A Pull Request** — provide a PR number (`42`, `#42`), URL (`https://github.com/org/repo/pull/42`), or `owner/repo#42`
> 2. **A Jira Ticket** — provide the ticket ID (e.g., `PROJ-123`) and I'll find the associated PR(s)
> 3. **A branch name** — provide the branch name and I'll find the associated PR
>
> Also, which **repo** should I look in?

Wait for the user's response. Do NOT proceed without knowing:
- The **PR or ticket** to review
- The **repo** (or repos) involved

### Disambiguating bare numbers

If the user provides just a number (e.g. `42`, `#42`) without a clear ticket prefix, it's ambiguous — it could be a **PR number** or a **Jira ticket number**. In that case, **ask the user to clarify**:

> Is `42` a **PR number** or a **Jira ticket number**?

Do NOT guess. Wait for confirmation before proceeding.

## Workflow

### Step 1: Resolve the PR

#### If the user gave a PR number or URL:
1. Extract the repo and PR number.
2. Navigate to the repo directory.
3. Fetch PR details and diff via `gh` CLI:
   ```bash
   gh pr view <number> --json title,body,baseRefName,headRefName,files,additions,deletions,changedFiles,reviews,comments,url
   gh pr diff <number>
   ```

#### If the user gave a branch name:
1. Navigate to the repo directory.
2. Check if there's a PR associated with that branch:
   ```bash
   gh pr list --head "<branch-name>" --json number,title,url,headRefName,baseRefName,state,additions,deletions,changedFiles
   ```
3. **If a PR exists**: Use it — this gives you the correct base branch, diff stats, and PR description. Fetch the full diff with `gh pr diff <number>`.
4. **If no PR exists**: Fall back to diffing against `master` (or `main`):
   ```bash
   git fetch origin
   git diff origin/master..origin/<branch-name>
   ```
   Inform the user that no PR was found and you're comparing against master:
   > ⚠️ No PR found for branch `<branch-name>`. Comparing against `master`.

#### If the user gave a Jira ticket ID:
1. Fetch ticket details using `jira_ticket` tool.
2. Search for associated PRs using a **multi-strategy approach** (try each until you find results):

   **Strategy 1: Filter all open PRs by branch name** (most reliable)
   ```bash
   cd <repo-dir>
   # List all open PRs and filter by branch name starting with ticket-id (lowercase)
   gh pr list --state open --limit 100 --json number,title,url,headRefName,baseRefName,state | \
     jq -c '.[] | select(.headRefName | startswith("<ticket-id-lowercase>"))'
   
   # If empty and ticket has different case, try uppercase
   gh pr list --state open --limit 100 --json number,title,url,headRefName,baseRefName,state | \
     jq -c '.[] | select(.headRefName | startswith("<ticket-id-uppercase>"))'
   ```
   
   **Strategy 2: Filter all open PRs by title** (if Strategy 1 returns empty)
   ```bash
   # Case-insensitive title search
   gh pr list --state open --limit 100 --json number,title,url,headRefName,baseRefName,state | \
     jq -c '.[] | select(.title | test("<ticket-id>"; "i"))'
   ```
   
   **Strategy 3: GitHub's built-in search** (if Strategy 2 returns empty)
   ```bash
   # Sometimes GitHub's search works, sometimes it doesn't
   gh pr list --search "<ticket-id>" --json number,title,url,headRefName,baseRefName,state
   ```
   
   **Strategy 4: Check closed/merged PRs** (if Strategy 3 returns empty)
   ```bash
   # Search in ALL recent PRs (open, closed, merged) - last 200
   gh pr list --state all --limit 200 --json number,title,url,headRefName,baseRefName,state | \
     jq -c '.[] | select(.headRefName | startswith("<ticket-id-lowercase>")) // select(.title | test("<ticket-id>"; "i"))'
   ```
   
   **After each search**: 
   - Count results with `| jq -s 'length'` to check if strategy succeeded
   - When a strategy succeeds, output: `✅ Found <count> PR(s) using Strategy <N>: <strategy-name>`
   - When strategies 1-2 fail, output: `⚠️ Trying GitHub's search API...` before Strategy 3
   - When Strategy 3 fails, output: `⚠️ Checking closed/merged PRs...` before Strategy 4

3. If multiple PRs are found, list them and ask the user which one to review.
4. If no PR is found after all strategies, inform the user with:
   > ❌ No PR found for `<ticket-id>` in `<repo>` after searching:
   > - ✓ Open PRs filtered by branch name (`<ticket-id>*`)
   > - ✓ Open PRs filtered by title (case-insensitive)
   > - ✓ GitHub search API
   > - ✓ All recent PRs (open, closed, merged)
   > 
   > Would you like me to:
   > 1. Check a different repo?
   > 2. Search for a specific branch name?
   > 3. Review local branch changes without a PR?

5. Once a PR is identified, fetch its diff as described above.

### 📢 Progress Output: After Resolving the PR

**Immediately after resolving the PR**, output a brief status so the user knows what was found:

> 🔎 **Found PR #`<number>`**: `<title>`
> `<url>`
> **Base**: `<base>` ← `<head>` | **Files changed**: `<count>` | `+<additions>` / `-<deletions>`

This gives the user instant confirmation that the right PR was identified before the slower analysis begins.

### Step 2: Load Context

1. Call `load_repo_context` for the affected repo(s).
2. Review ticket description and acceptance criteria if available.

### Step 3: Understand the Change

1. Read the PR description/ticket to understand the goal.
2. Review the file list to understand scope.
3. Identify the type of change: feature, bugfix, refactor, config, test-only, etc.
4. Categorize changed files based on the project's architecture (check memory files for the project's structure — e.g., MVC layers, modules, packages, contexts).

### 📢 Progress Output: Scope Overview

**After understanding the change, output a scope summary** before starting the deep review:

> 📋 **Change scope**: `<type>` (feature / bugfix / refactor / etc.)
> **Areas touched**:
> - [Category]: `file1`, `file2`
> - [Category]: `file3`
> - Tests: `file4`, `file5`
> - (etc.)
>
> Use the project's own architectural categories from memory files (e.g., Models/Controllers/Views for MVC, Contexts/LiveViews for Phoenix, Handlers/Repositories for Go, Components/Hooks for React, etc.).
>
> ⏳ Starting deep review...

This lets the user understand the scope and know the analysis is underway.

### Step 4: Deep Review

Go through the diff carefully. For each file, read the surrounding context in the actual codebase (not just the diff) to understand the full picture.

**As you review each area**, output brief progress indicators so the user sees activity:
- When reading a file for context: no output needed (the tool call is visible).
- **When you finish reviewing a logical area** and find issues, you may output early findings inline before moving to the next area. This is optional for small PRs but **recommended for PRs with 5+ files changed**.

Check for:

#### Correctness
- Does the code do what the ticket/PR description says?
- Are edge cases handled?
- Are there off-by-one errors, nil safety issues, or race conditions?
- Do database queries perform well (N+1, missing indexes)?

#### Architecture & Patterns
- Does it follow existing patterns in the repo? (Check memory files)
- Is the change in the right place? (right repo, right layer)
- Are new files in the right directories following conventions?

#### Security
- Are there authorization checks?
- Is user input sanitized?
- Are there mass assignment or input validation vulnerabilities?
- Any exposed secrets or hardcoded credentials?

#### Testing
- Are there tests for new/changed functionality?
- Do tests cover edge cases and error paths?
- Do tests follow existing patterns?
- Are the right test types used?

#### Style & Maintainability
- Is the code readable and well-named?
- Are there unnecessary comments or commented-out code?
- Is there duplication that should be extracted?
- Are methods/classes appropriately sized?

### Step 5: Present the Review

---

## Code Review: `<PR title>` (`<repo>#<number>`)

### Summary
One paragraph explaining what the PR does and the overall impression.

### ✅ What Looks Good
- Positive feedback on things done well.

### 🔍 Issues & Suggestions

For each issue:

#### [severity] File: `path/to/file` (line X-Y)
> ```
> # the problematic code snippet
> ```
**Issue**: Explain what's wrong or could be improved.
**Suggestion**: Show how to fix it.

Severity levels:
- 🔴 **Must Fix** — Bugs, security issues, data loss risks
- 🟡 **Should Fix** — Logic issues, missing edge cases, pattern violations
- 🟢 **Nit** — Style, naming, minor improvements (optional)
- 💬 **Question** — Things that need clarification

### 🧪 Testing Assessment
- Are tests adequate? What's missing?

### 📋 Checklist
- [ ] Follows repo patterns and conventions
- [ ] Changes are in the correct repo/layer
- [ ] Authorization is properly handled
- [ ] Tests cover the new functionality
- [ ] No N+1 queries introduced
- [ ] Migrations are reversible (if applicable)

---

### Step 6: Offer Next Steps

> Would you like me to:
> 1. Post these comments on the PR via `gh`?
> 2. Help fix any of the issues found?
> 3. Look at something specific in more detail?
