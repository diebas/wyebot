---
name: learn
description: Review recent code changes (yours or from the team) and update memory files with relevant learnings. Works on feature branches (your diff) or master/main (recent commits after fetch/pull).
---

# Learn from Recent Changes

Analyze recent code changes and update the memory files with anything relevant.

## Input

The user may provide:
- **Repo name(s)**: Which repo(s) to analyze. Can be a single repo, a list, or "all". If not provided, ask.
- **Branch**: Optionally, a specific branch to analyze. If not provided, the skill uses the default flow (see below).
- **Context**: Optional description of what was done (helps focus the analysis).

## Repo Location

Repos are located at the path specified in `.pi/local.json` (`reposPath`), or check `project.yml` for configured repos, or use the current working directory as fallback.

## Workflow

### Step 1: Identify the Repo and Branch

Navigate to the specified repo directory and run:
```
git branch --show-current
git remote -v
```

### Step 2: Safe Switch to Master (when no specific branch is requested)

When the user provides **only a repo name** (no specific branch), the goal is to learn from the latest team changes on master. Follow this safe-switch procedure:

1. **Record the current branch**:
   ```
   git branch --show-current
   ```
   Save this as `original_branch`.

2. **Check for uncommitted changes**:
   ```
   git status --porcelain
   ```

3. **If there are uncommitted changes**, stash them:
   ```
   git stash push -m "learn-skill-auto-stash"
   ```
   Set `did_stash = true`.

4. **Switch to master/main**:
   ```
   git checkout master
   ```
   (Use `main` if the repo uses `main` instead of `master`.)

5. **Fetch and pull latest**:
   ```
   git fetch origin
   git pull origin master
   ```

6. **Proceed with analysis** (Step 3 below).

7. **After analysis is complete**, restore the original state:
   ```
   git checkout <original_branch>
   ```
   If `did_stash == true`:
   ```
   git stash pop
   ```

**If the user provides a specific branch**, just navigate to the repo and analyze that branch as-is (don't switch branches).

### Step 3: Branch-Dependent Analysis

#### If on `master` or `main` (team changes):
1. Review recent commits (last 30):
   ```
   git log --oneline -30
   ```
2. For commits that look significant (new features, refactors, config changes), inspect the actual diff:
   ```
   git show <commit-hash> --stat
   git show <commit-hash>
   ```
3. Focus on: new modules/types, new services or abstractions, config changes, new patterns, schema/migration changes.

#### If on a feature branch (your own work):
1. Determine the base branch (usually `master` or `main`):
   ```
   git merge-base master HEAD
   ```
2. Review the full diff from the base:
   ```
   git diff master..HEAD --stat
   git diff master..HEAD
   ```
3. Review the commit log for this branch:
   ```
   git log master..HEAD --oneline
   ```
4. Focus on: what was added/changed, new patterns introduced, configuration changes, new test patterns.

### Step 4: Load Current Memory

Call `load_repo_context` for the repo being analyzed so you know what's already documented.

### Step 5: Analyze for Memory-Worthy Changes

Look for these categories of learnings:

**Architecture (`memory/ARCHITECTURE.md`)**:
- New extension points or patterns
- Changes to the domain model (new types, entities, or relationships)
- New integrations or services
- Changes to the deployment or configuration system

**Directives (`memory/DIRECTIVES.md`)**:
- New conventions introduced (naming, testing, code organization)
- New rules or constraints discovered
- Changes to the development workflow

**Repo-specific (`memory/repos/<repo>.md`)**:
- New features or customizations
- New important files
- Changes to configuration
- New testing patterns or factories
- New services or business logic
- Updates to deployment process
- New technical debt or known issues

### Step 6: Update Memory Files (Topic-Based Upsert)

Memory files use **topic-based organization**. The "Learned Patterns" (DIRECTIVES.md) and "Discovered Patterns" (ARCHITECTURE.md) sections are organized by topic headings (e.g., `### Authentication`, `### Testing Patterns`).

For each learning found:
1. Determine which memory file it belongs in.
2. **Find the matching topic** subsection.
3. **Update the existing topic in-place** — add new bullet points or revise existing ones. Do NOT create a duplicate topic.
4. **Only create a new `###` topic** if no existing topic fits the learning.
5. For repo-specific memory files, add to the relevant content section. Prefix entries with the date: `- **[YYYY-MM-DD]**: Description`.
6. If existing content is outdated, **replace it** rather than appending.

### Step 7: Summary

Present a summary to the user:
- How many commits/changes were analyzed
- What was added to memory files (list each update)
- Anything notable that doesn't fit in memory files but is worth knowing
- Confirm the repo was left on its original branch (and stash was restored if applicable)

## Handling Multiple Repos

When the user says "all repos" or provides a list:
1. Process each repo sequentially using the same workflow above.
2. For each repo, do the full safe-switch → analyze → restore cycle independently.
3. At the end, present a combined summary across all repos.

## Important Notes

- **Don't over-document**: Only capture patterns, conventions, and structural changes. Skip trivial bugfixes or typo corrections.
- **Be specific**: "Added FooService for handling bar" is better than "Added a new service".
- **Update, don't duplicate**: If something is already documented, update the existing entry if needed.
- **Respect the structure**: Follow the existing format of each memory file.
- **No code changes**: This skill only reads code and updates memory. Never modify application code.
- **Always restore**: The repo MUST be left on its original branch with its stash restored, even if the analysis fails or is interrupted.
