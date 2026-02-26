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
> 1. **A Pull Request** — provide the PR number or URL (e.g., `#42`, `https://github.com/org/repo/pull/42`)
> 2. **A Jira Ticket** — provide the ticket ID (e.g., `PROJ-123`) and I'll find the associated PR(s)
>
> Also, which **repo** should I look in?

Wait for the user's response.

## Workflow

### Step 1: Resolve the PR

#### If the user gave a PR number or URL:
1. Extract the repo and PR number.
2. Navigate to the repo directory.
3. Fetch PR details and diff via `gh` CLI.

#### If the user gave a Jira ticket ID:
1. Fetch ticket details using `jira_ticket` tool.
2. Search for associated PRs.
3. If multiple PRs found, ask which to review.
4. If no PR found, ask if they want to review a branch diff instead.

### Step 2: Load Context

1. Call `load_repo_context` for the affected repo(s).
2. Review ticket description and acceptance criteria if available.

### Step 3: Understand the Change

1. Read the PR description/ticket to understand the goal.
2. Review the file list to understand scope.
3. Identify the type of change: feature, bugfix, refactor, config, test-only, etc.

### Step 4: Deep Review

Go through the diff carefully. Read surrounding context in the actual codebase.

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
- Are there mass assignment vulnerabilities (strong params)?
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
