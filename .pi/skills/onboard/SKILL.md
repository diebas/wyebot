---
name: onboard
description: Scan your project repos, detect tech stack, conventions, and relationships, then generate project.yml and memory files. Run once for initial setup or to refresh after major changes.
---

# Onboard Project

You are running the project onboarding flow for wyebot. This skill analyzes the project,
detects its tech stack, conventions, and structure, and generates all configuration and
memory files so the agent is tailored to this specific project.

## Step 0: Determine Mode

The mode is passed in the user message: `fresh`, `reset`, or `complement`.

- **fresh / reset**: Delete all existing memory files and `project.yml`, start from scratch.
- **complement**: Keep existing files, scan repos, and add/update information without removing what's already there. Always preserve "Learned Patterns" and "Discovered Patterns" entries.

## Step 1: Find Repositories

### Auto-detection
1. Check if `.pi/local.json` exists and has `reposPath`. If so, use that as the base directory.
2. Otherwise, use the current working directory.
3. Scan the base directory for subdirectories containing `.git`.
4. Present the list of found repos to the user.

If NO repos are found, ask:
> **No git repositories found in `<path>`. Where are your repos located?**

### Verify
Once repos are identified, list them and ask the user to confirm:
> **Found these repositories:**
> - `my-backend/` (Rails app)
> - `my-frontend/` (React app)
> - `shared-lib/` (Node package)
>
> **Are these correct? Should I add or remove any?**

Wait for confirmation before continuing.

## Step 2: Scan Each Repository

For each repository, gather:

### 2a. Tech Stack Detection
- **Ruby/Rails**: Check `Gemfile`, `Gemfile.lock`, `.ruby-version` for Ruby version, Rails version
- **Node/JS/TS**: Check `package.json` for framework (React, Vue, Angular, Next.js, Express, etc.), Node version from `.node-version` or `engines`
- **Python**: Check `requirements.txt`, `pyproject.toml`, `Pipfile` for framework (Django, FastAPI, Flask)
- **Go**: Check `go.mod` for Go version and key dependencies
- **Other**: Check for `Cargo.toml` (Rust), `pom.xml` (Java), etc.
- **Database**: Check `docker-compose.yml`, `database.yml`, or equivalent for DB type (PostgreSQL, MySQL, MongoDB, etc.)
- **Docker**: Check `Dockerfile`, `docker-compose.yml` for containerization

### 2b. Testing Detection
- **Framework**: RSpec (`spec/`), Minitest (`test/`), Jest (`__tests__/`, `*.test.js`), pytest (`tests/`, `*_test.py`), Go test (`*_test.go`)
- **Factories**: FactoryBot (`spec/factories/`), fixtures, seeds
- **System/E2E tests**: Capybara, Playwright, Cypress, Selenium
- **Test count**: `find spec -name "*_spec.rb" | wc -l` or equivalent
- **Test helpers**: Look for shared examples, custom matchers, test support files
- **Factory syntax**: Check if `FactoryBot::Syntax::Methods` is included (Rails) — if so, note in directives to use short syntax

### 2c. Linting & Code Quality
- **Ruby**: `.rubocop.yml` → note "Run `rubocop -A` after implementing"
- **JavaScript/TypeScript**: `.eslintrc*`, `.prettierrc*` → note the lint command
- **Python**: `ruff.toml`, `.flake8`, `pyproject.toml [tool.ruff]` → note the lint command
- **General**: `.editorconfig`, `.pre-commit-config.yaml`

### 2d. CI/CD
- `.github/workflows/` → GitHub Actions (list workflow names)
- `.circleci/config.yml` → CircleCI
- `.gitlab-ci.yml` → GitLab CI
- `Jenkinsfile` → Jenkins
- Note what the CI runs (tests, lint, deploy, etc.)

### 2e. Auth & Authorization
- **Ruby gems**: Devise, Warden, OmniAuth, CanCanCan, Pundit, ActionPolicy
- **Node packages**: passport, jsonwebtoken, express-jwt, casl
- **Python packages**: django-allauth, django-rest-framework (permissions), FastAPI security
- Note in ARCHITECTURE which system is used

### 2f. Domain Structure
- **Models**: Scan `app/models/` (Rails), or equivalent. List key models, detect STI, state machines (AASM), important relationships
- **Controllers**: Count controllers, detect API namespaces, REST patterns
- **Services**: Scan `app/services/`, list naming conventions
- **Engines/Plugins**: Check `vendor/engines/`, `engines/`, `packages/` for modular architecture
- **Routes**: Scan `config/routes.rb` or equivalent for main endpoints, API namespaces

### 2g. PR Templates
- Look for PR templates in these locations:
  - `.github/pull_request_template.md`
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `docs/pull_request_template.md`
  - `.github/PULL_REQUEST_TEMPLATE/` (directory with multiple templates)
- Note the path in `project.yml` conventions

### 2h. Branch & Commit Conventions
- **Branches**: Run `git branch -r | head -50` and analyze naming patterns:
  - `feature/description`, `fix/description` → prefix-based
  - `PROJ-123/description` → ticket-prefix
  - `description-only` → freeform
- **Commits**: Run `git log --oneline -30` and analyze message patterns:
  - `feat: description`, `fix: description` → conventional commits
  - `PROJ-123 description` → ticket-prefix
  - Freeform otherwise

### 2i. Git Info
- Current branch, recent activity, remotes
- Relationship detection: check `git remote -v` across repos to detect forks (same remote URL patterns)

## Step 3: Interactive Questions

After the automated scan, ask these questions that can't be detected from code:

### Q1: Project Description
> **What does this project do?** (1-2 sentences — this helps the agent understand the domain)

### Q2: Repo Relationships
> **How do these repos relate to each other?**
> 1. Independent (separate projects)
> 2. Monorepo with packages
> 3. Parent + forks (one base repo with forks per client/instance)
> 4. Backend + Frontend + shared libs
> 5. Other (describe)

### Q3: Agent Autonomy
If `project.yml` already has an `agent` section (e.g., from `/setup`), show the current config and ask:
> **Agent autonomy is already configured:**
> - Git: branches ✅, commit ❌, push ❌, PRs ❌
> - Execution: tests ✅, linter ✅, deps ❌, migrations ❌
> - Services: PR comments ❌, Jira ❌
>
> **Keep this config or reconfigure?**

If NOT already configured, ask:
> **How much should the agent do on its own?**
> 1. Conservative — I control git, agent runs tests and linter ← default
> 2. Balanced — Agent handles branches and commits, I handle push/PRs
> 3. Full auto — Agent handles everything including push and PRs
> 4. Custom — Let me choose each setting

For Custom, ask each category:
- **Git**: None / Branches only / Branches + commits / Full (branches, commits, push, PRs)
- **Execution**: Tests and linter only / Full (+ deps + migrations) / None
- **Services**: None / Comment on PRs / PRs + Jira
- **Planning**: Mixed / Confirmatory / Autonomous

### Q4: Protected Files
> **Are there files the agent should NEVER modify?** (e.g., .env, secrets, CI config)
> Enter paths separated by commas, or "none".

### Q5: Additional Guardrails
> **Any other rules for the agent?** (free text, or "none")
> Examples: "Always write tests before implementation", "Never modify the database schema directly"

### Q6: Deployment
> **How do you deploy?**
> 1. Automatic on merge to main (CI/CD)
> 2. Manual with tags/releases
> 3. Other: ___

### Q7: PR/Merge Strategy
> **How do you handle PRs?**
> 1. Squash merge
> 2. Rebase merge
> 3. Merge commit
>
> **How many approvals required?** (default: 1)

Wait for answers before proceeding.

## Step 4: Generate `project.yml`

Write the `project.yml` file with all detected and user-provided information. Include:
- Project name and description (from Q1)
- All repos with their type, path, and detected stack
- Repo structure (from Q2)
- Detected conventions (branch format, commit format, linter command, test command, PR template path, merge strategy from Q7)
- Deployment info (from Q6)
- Agent config with structured autonomy (from Q3):
  ```yaml
  agent:
    autonomy: mixed            # planning: confirmatory | autonomous | mixed
    git:
      create_branches: true
      commit: false
      push: false
      create_pr: false
    execution:
      run_tests: true
      run_linter: true
      install_dependencies: false
      run_migrations: false
    services:
      comment_on_prs: false
      update_jira: false
    guardrails: []             # from Q5
    protected_files: []        # from Q4
  ```
  If `project.yml` already has an `agent` section (from `/setup`) and the user chose to keep it, preserve those values.
- Jira config: leave board_id as null, suggest user fills it in if they use Jira

## Step 5: Generate `memory/DIRECTIVES.md`

Generate a DIRECTIVES.md file populated with detected conventions. Structure:

```markdown
# Project Directives

> This file defines how the agent should behave when working in this project.
> Auto-generated by /onboard on [date]. Review and adjust as needed.
> Update with new learnings as you work.

## Quick Reference

> Scan this section first for rapid orientation.

- **Repos**: [list of repos with one-line descriptions]
- **Stack**: [detected tech stack summary]
- **Testing**: [test command]. Never [framework-specific anti-patterns detected].
- **Code quality**: Run [linter command] after implementing.
- **Branch format**: [detected convention]
- **Guardrails**: [from Q3]

## Core Principles

### Branch Management
[Detected branch naming convention with examples from actual branches found]

### Testing Standards
[Detected testing framework, factory patterns, test count per repo]
[Framework-specific best practices — e.g., "Use short FactoryBot syntax" if detected]

### Code Quality
[Detected linter and its configuration]
[Any additional quality tools found]

### Commit Discipline
[Detected commit message convention]
[Guardrails about git operations from Q3]

### [Repo Relationship Rules — only if multi-repo]
[Rules based on Q2 — e.g., "parent vs fork" placement rules, shared code guidelines]

## Conventions
[All detected conventions: PR template location, CI pipeline, deployment notes]

## Communication Patterns

### Context Reminders
- Every 2-3 messages, include a brief context reminder at the top of the response.
- Format: `> 📌 **Context**: Working on [ticket/task] — [brief description]`

## Learned Patterns

> Organized by topic. When learning something new, find the matching topic and update in-place.
> Only create a new topic if nothing existing fits.
```

## Step 6: Generate `memory/ARCHITECTURE.md`

Generate an ARCHITECTURE.md file populated with detected structure. Structure:

```markdown
# Project Architecture

> This file documents the project architecture across all repositories.
> Auto-generated by /onboard on [date]. Review and adjust as needed.

## Quick Reference

> Scan this section first for rapid orientation.

- **Stack**: [full stack summary with versions]
- **Domain**: [brief domain model summary if detected]
- **Auth**: [detected auth/authz system]
- **Repos**: [count] repositories — [structure type]

## Overview
[Project description from Q1]

## Repository Map
[Table or tree of all repos with: name, stack, type, brief description]

## Technology Stack
[Table with: Layer, Technology, Version — for each repo if they differ]

## Core Domain Model
[Key models detected, their relationships if inferable]
[STI hierarchies, state machines if detected]

## Key Business Logic Areas
[Services detected, naming conventions, important patterns]

## External Integrations
[APIs, payment processors, email services, monitoring — detected from dependencies]

## Configuration System
[Environment config patterns detected: .env, credentials, settings files]

## Deployment
[Deployment info from Q4 and detected config files]

## Discovered Patterns

> Organized by topic. When discovering something new, find the matching topic and update in-place.
> Only create a new topic if nothing existing fits.
```

## Step 7: Generate Per-Repo Memory Files

For each repo, write `memory/repos/<repo-name>.md`:

```markdown
# <Repo Name>

> Last scanned: [date]
> Branch: [current branch]
> Stack: [detected stack and version]

## Overview
[Brief description — type of app, framework, what it does if determinable]

## Important Files
[Key files discovered: main config, routes, models, entry points]

## Models & Domain Logic
[Key models found, state machines, relationships]

## Configuration
[Settings files, env config, feature flags if detectable]

## Testing Notes
[Test framework, factory patterns, test count, shared examples found]

## Known Issues / Technical Debt
[Any issues discovered during scanning — e.g., outdated dependencies, TODO comments]

## Discovered Patterns
[Patterns unique to this repo — populated as the agent works]
```

## Step 8: Present Summary

Show the user a summary of everything that was configured:

```
## ✅ Onboarding Complete

### Project: [name]
[description]

### Repos Configured: [count]
| Repo | Stack | Type |
|------|-------|------|
| my-backend | Rails 7.1 / Ruby 3.3 | primary |
| my-frontend | React 18 / Node 20 | service |

### Detected Conventions
- Branch format: [format]
- Commit format: [format]
- Linter: [command]
- Test command: [command]
- CI: [system]

### Files Generated
- project.yml
- memory/DIRECTIVES.md
- memory/ARCHITECTURE.md
- memory/repos/[repo].md (x[count])

### Next Steps
1. **Review `project.yml`** and adjust any detected values that are wrong.
2. **Review `memory/DIRECTIVES.md`** — add any team conventions the scan couldn't detect.
3. **Review `memory/ARCHITECTURE.md`** — add domain knowledge and business context.
4. If you use Jira, set `jira.board_id` in `project.yml` (run `/jira-login` first).
5. Start working! Try `/ticket` to work on a ticket or just describe what you need.
```

## Important Notes

- All generated files must be in **English** regardless of the user's language.
- Be thorough but concise. Focus on information useful for day-to-day development.
- Don't include sensitive information (secrets, credentials, API keys).
- Note the date of the scan so we know when information was last refreshed.
- If a repo has an unusual structure, note it but don't force it into standard patterns.
- Report progress as you go — scanning can take a while for large projects.
- In **complement** mode: preserve all existing "Learned Patterns" and "Discovered Patterns" entries. Only add new information or update outdated entries.
