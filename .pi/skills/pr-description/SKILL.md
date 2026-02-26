---
name: pr-description
description: Generate a pull request description based on the current branch changes and the repo's PR template. Returns copy-paste-ready markdown.
---

# Generate PR Description

Generate a pull request description for the current branch, ready to paste into GitHub.

## Input Required

Ask the user for:
1. **Which repo**: Which repository is the PR for?
2. **Ticket reference**: The ticket/issue number or link (if any)
3. **Additional context**: Anything not obvious from the code changes

## Workflow

### Step 1: Find the PR Template

Check `project.yml` for `conventions.pr_template`. If not set, look in these standard locations:
- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE/` (directory)

Read the template to understand the expected format and sections.

If no template is found, use a generic PR structure (Title, What Changed, Why, Testing, Screenshots).

### Step 2: Analyze the Changes
In the specified repo directory:

1. **Identify the base branch**: Usually `master` or `main`.
2. **Get the commit log**: `git log <base>..HEAD --oneline` to see all commits.
3. **Get the diff stats**: `git diff <base>..HEAD --stat` to see scope.
4. **Get the full diff**: `git diff <base>..HEAD` to understand the actual changes.
5. **Understand the scope**: Which files changed, what was added/removed/modified.

### Step 3: Generate the Description
Fill in the PR template sections with content based on the actual changes:

- **Summary/Notes**: 1-2 sentence explanation suitable for release notes. Describe the user-facing impact.
- **Link to Issue**: Include the ticket/issue reference if provided.
- **What changed**: Summarize the technical changes clearly.
- **Screenshots**: Note `[TODO: Add screenshots]` for UI changes.
- **Additional Context**: Deployment steps, configuration changes, migration notes, etc.
- Mention if the PR depends on changes in other repos.
- Include migration steps if database changes are involved.
- Note any feature flags or configuration changes needed.

### Step 4: Output

**CRITICAL OUTPUT FORMAT**: Your final output MUST be exactly two things:

1. A suggested **PR title** (one line, under 70 characters).

2. The **PR body** inside a single markdown code block (triple backticks with `markdown` language tag). The content inside the code block must follow the repo's PR template structure exactly. Nothing else outside the code block.

Format:

**Title:** `Suggested PR title here`

**Body:**
````
```markdown
[The entire PR description here, following the repo's template exactly.
This is what the user will copy-paste directly into GitHub.
Use proper markdown: headers, lists, checkboxes, links, etc.]
```
````

**DO NOT** add any commentary, explanation, or formatting outside of the title line and the code block. The user needs to copy the content inside the code block as-is into GitHub.
