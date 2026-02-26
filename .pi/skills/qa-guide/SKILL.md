---
name: qa-guide
description: Generate a step-by-step QA testing guide from a Jira ticket or PR. Fetches ticket requirements, finds associated PRs, analyzes code changes, and produces a comprehensive manual testing plan with preconditions, steps, expected results, and edge cases.
---

# QA Testing Guide Generator

Generate a comprehensive, step-by-step QA testing guide by combining Jira ticket requirements with PR code analysis.

## Input Required

**Always ask the user before proceeding.** Present these options:

> What should I build the QA guide for?
>
> 1. **A Jira Ticket** — provide the ticket ID (e.g., `PROJ-123`)
> 2. **A Pull Request** — provide the PR number or URL (e.g., `#42`, `https://github.com/org/repo/pull/42`)
> 3. **Both** — provide both for maximum context
>
> Which **repo** should I look in?

Wait for the user's response. Do NOT proceed without knowing:
- The **ticket and/or PR** to analyze
- The **repo** (or repos) involved

## Workflow

### Step 1: Gather Requirements (Jira)

#### If the user provided a Jira ticket ID:
1. Fetch ticket details using `jira_ticket` tool (with `includeComments: true` for extra context).
2. Extract: Summary, Description, Acceptance Criteria, Type, Comments.
3. Note any ambiguities or missing details.

#### If the user provided only a PR (no ticket):
1. Try to extract a ticket ID from the PR title or branch name.
2. If found, fetch the ticket details.
3. If not found, proceed with PR-only analysis.

### Step 2: Find and Analyze the PR

#### If the user provided a PR:
1. Navigate to the repo directory.
2. Fetch PR details and diff via `gh` CLI.

#### If the user provided only a ticket:
1. Search for associated PRs:
   ```bash
   gh pr list --search "<ticket-id>" --state all --json number,title,url,headRefName,state
   ```
2. If multiple PRs found, ask which one to use.
3. If no PR found, offer to generate a requirements-only QA guide.

### Step 3: Load Repo Context

Call `load_repo_context` for the affected repo(s) to understand auth models, patterns, and conventions.

### Step 4: Analyze the Changes

Build a comprehensive understanding:

1. **Categorize changed files**: Models, Controllers, Views, Services, Migrations, Config/Routes, Tests.
2. **Read key changed files in full** (not just the diff) to understand complete context.
3. **Identify authorization changes**: New permission rules, access controls, role checks.
4. **Identify UI changes**: New pages, forms, modals, navigation changes, messages.
5. **Identify data flow**: Params accepted, DB changes, emails sent, side effects.

### Step 5: Cross-Reference Requirements with Code

1. Map each acceptance criterion to specific code changes.
2. Identify acceptance criteria without corresponding code (potential gaps).
3. Identify code changes beyond acceptance criteria (scope creep).
4. Note implicit requirements from the code (error handling, edge cases).

### Step 6: Generate the QA Testing Guide

---

## 🧪 QA Testing Guide: `<Ticket ID>` — `<Summary>`

### Overview
Brief description of what this feature/fix does and why it matters.

### Preconditions
- **User roles needed**: List specific roles to test with.
- **Feature flags**: Any flags that must be enabled/disabled.
- **Data setup**: Required data that must exist.
- **Configuration**: Settings or env changes needed.
- **Server/Branch**: Which branch to test on, any pending migrations.

### Test Scenarios

Organize in this order:

1. **Happy Path** — The main flow works as described.
2. **Authorization / Permissions** — Test with different roles (allow + deny).
3. **Validation / Error Handling** — Invalid inputs, required fields, boundary conditions.
4. **Edge Cases** — Empty states, concurrent access, browser quirks.
5. **Regression Checks** — Adjacent features that should still work.

For each scenario:

#### Scenario N: `<Descriptive Name>`
**Goal**: What this scenario verifies.
**Role**: Which user role to test as.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `<URL>` | Page loads, shows `<expected content>` |
| 2 | Click `<element>` | `<what should happen>` |
| 3 | Fill in `<field>` with `<value>` | Field accepts input |
| 4 | Click `<submit>` | `<success behavior>` |

### Destructive / Negative Tests
- Direct URL manipulation (bypass UI guards).
- Submit forms with tampered params.
- Access pages without required permissions.

### Data Verification
- Records created/updated correctly.
- Audit trail entries (if applicable).
- Emails sent (check mailer logs).
- No orphaned or inconsistent data.

### Notes
- Ambiguities in requirements.
- Areas where automated test coverage is weak.

---

### Step 7: Browser Verification (Optional)

If the `browser` tool is available AND the developer wants automated QA:
1. Ask if the server is running and if they're logged in.
2. Execute key happy-path scenarios.
3. Present results with screenshots.

### Step 8: Offer Next Steps

> Would you like me to:
> 1. **Run the QA steps** in the browser automatically?
> 2. **Go deeper** on a specific scenario or edge case?
> 3. **Export** this guide as a markdown file?
> 4. **Review the code** for any issues I noticed during analysis?

## Important Rules

- **Be exhaustive but organized** — better to have too many test cases than too few.
- **Think like a QA engineer**, not a developer — focus on user-visible behavior.
- **Always test authorization** — every new endpoint or action must be tested with multiple roles.
- **Always test the negative** — invalid inputs, unauthorized access, missing data.
- **Reference specific URLs** where possible.
- **Include the acceptance criteria mapping** so the reviewer can trace each AC to test scenarios.
- **Read test files from the PR** — they reveal expected behavior and edge cases.
