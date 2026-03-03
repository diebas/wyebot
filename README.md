# wyebot — AI Development Agent

A project-aware AI development agent built on [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Scans your codebase, learns your conventions, and helps you build, test, review, and ship — with persistent memory across sessions.

## What It Does

- **Smart project onboarding**: Scans your repos, detects tech stack, testing patterns, linting, CI, branch conventions — and configures itself automatically
- **Persistent memory system**: Maintains project knowledge across sessions (directives, architecture, per-repo learnings)
- **Multi-repo awareness**: Works across multiple repositories with understanding of their relationships
- **Jira integration**: Fetch tickets and sprint data directly from Jira Cloud
- **Parallel code review**: Multi-model AI review that runs multiple models in parallel (Claude, GPT, Gemini, etc.) and consolidates findings by consensus — 30-60s vs minutes with traditional reviews
- **Smart PR descriptions**: Generates PR descriptions from your branch diff using your repo's template
- **QA guide generation**: Builds step-by-step QA testing guides from Jira tickets and PRs
- **Work recaps**: Summarizes recent sessions — tickets, PRs, decisions — for standup prep
- **Flaky test diagnosis**: Reproduces, analyzes, fixes, and verifies intermittent test failures across any framework
- **Interactive rebase**: PR-aware rebase with conflict resolution guidance and force push safety
- **Browser automation**: Automated browser-based QA verification using Playwright

## Prerequisites

1. **Pi coding agent** — Install from [github.com/pi-mono/coding-agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent)
2. **AI provider account** — Anthropic (Claude), OpenAI (GPT), or Google (Gemini)
3. **GitHub CLI** (optional) — Install from [cli.github.com](https://cli.github.com/) for PR/review features
4. **Playwright** (optional) — For browser-based QA. Run `/browser-setup` inside the agent to install

## Quick Start

### 1. Clone this repo

```bash
git clone <this-repo-url> my-project-agent
cd my-project-agent
```

### 2. Point to your repos (if they're not in this directory)

Create `.pi/local.json` (gitignored):

```json
{
  "reposPath": "/path/to/your/repos"
}
```

### 3. Launch and setup

```bash
chmod +x wyebot.sh
./wyebot.sh
```

Then inside the agent:
```
/setup
```

The setup wizard walks you through:
1. **Choose AI provider** — Anthropic, OpenAI, or Google
2. **Select model** — Pick from available models
3. **Connect services** — Optionally connect Jira and/or GitHub
4. **Onboard your project** — Scans your repos and configures everything

### 4. Start working

```
/ticket PROJ-123             # Work on a Jira ticket
/ticket Fix the login bug    # Work from a description
/pr-desc my-app              # Generate a PR description
/parallel-review             # Multi-model code review
/parallel-review-lite        # Quick review (3 models max)
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands grouped by category |
| `/setup` | Guided first-time setup wizard |
| `/onboard` | Scan repos, detect conventions, generate config and memory |
| `/ticket [ID or desc]` | Work on a ticket — plan, implement, test, QA |
| `/pr-desc [repo]` | Generate PR description from branch diff |
| `/learn [repo]` | Review recent changes and update memory |
| `/recap` | Summarize recent work sessions |
| `/flaky-test [test path]` | Diagnose and fix intermittent test failures |
| `/rebase` | PR-aware interactive rebase |
| `/parallel-review [repo\|PR]` | Multi-model parallel review (all configured models) |
| `/parallel-review-lite [repo\|PR]` | Quick parallel review (max 3 models, faster) |
| `/qa-guide` | Generate QA testing guide from ticket/PR |
| `/browser-setup` | Install Playwright for browser QA |
| `/browser-reset` | Reset browser session |
| `/memory` | Show memory files status |
| `/change-provider` | Switch AI provider and model |
| `/jira-login` | Configure Jira credentials |
| `/github-login` | Setup GitHub CLI authentication |

## Command Workflows

Detailed flows for the more complex commands:

### `/ticket [ID or description]`

**Purpose**: Full development workflow from ticket analysis to implementation.

**Flow**:
1. **Fetch ticket** — Retrieves ticket from Jira (or uses provided description)
2. **Analyze requirements** — Breaks down acceptance criteria and technical requirements
3. **Load context** — Loads relevant repo memory files based on what needs to change
4. **Plan implementation** — Creates a multi-repo implementation plan with step-by-step tasks
5. **Confirm plan** — Presents plan for review (behavior depends on `agent.autonomy` setting)
6. **Implement changes** — Makes code changes across affected repos
7. **Add/update tests** — Creates or modifies tests to cover new functionality
8. **Run tests** — Executes test suite if `agent.execution.run_tests: true`
9. **Run linter** — Auto-fixes code style if `agent.execution.run_linter: true`
10. **Update memory** — Records new patterns and learnings in memory files
11. **Create PR** — Optionally creates PR if `agent.git.create_pr: true`

**Example**:
```
/ticket PROJ-123
/ticket Add password reset functionality to user settings
```

### `/parallel-review [repo|PR-url|ticket-id]`

**Purpose**: Multi-model parallel code review — runs multiple AI models simultaneously and consolidates findings by consensus.

**How it works**:
- **Dynamic model selection** — Automatically uses all configured AI providers (Claude, GPT, Gemini, xAI, etc.)
- **Parallel execution** — All models review the same diff independently (~300ms stagger to avoid conflicts)
- **Single-shot analysis** — Each model receives the full diff and responds immediately (no tool calls), making reviews fast (15-45s per model)
- **Consensus ranking** — Findings are grouped by similarity and ranked by `consensusScore = agents_count × severity_weight`
- **Real-time progress** — Shows live status as each agent completes

**Flow**:
1. **Interactive picker** — Choose what to review:
   - Current branch vs base (master/main)
   - A specific PR (by number, URL, Jira ticket ID, or branch name)
   - Skip picker by providing: `/parallel-review https://github.com/org/repo/pull/123`
2. **Fetch diff** — Retrieves the complete changeset
3. **Launch parallel agents** — Spawns one agent per configured AI model:
   - Up to 3 Claude models (Opus, Sonnet, Haiku)
   - 1 agent per other provider (GPT, Gemini, xAI, etc.)
   - Each reviews for: bugs, security, performance, style, best practices
4. **Consolidate findings** — Groups similar issues by file + line + description overlap
5. **Rank by consensus** — Issues found by multiple models rank higher than single-model findings
6. **Generate report** — Markdown report with:
   - Findings grouped by severity (🔴 Critical, 🟡 Warnings, 🟢 Suggestions)
   - Consensus tags showing `[3/4 agents]` for each finding
   - Per-agent scores (1-10) and finding counts
   - Combined summary from all agents

**Example output**:
```markdown
### 🔴 Critical Issues — 2

**[3/4 agents]** `app/controllers/orders_controller.rb:45` — **Missing authorization**
  No authorization check before accessing sensitive order data.
  > 💡 Add authorization check: `authorize! :manage, @order`

### Scores
| Agent              | Score | Findings |
|--------------------|-------|----------|
| claude-opus-4-6    | 7/10  | 8        |
| gemini-2.5-pro     | 8/10  | 5        |
| gpt-5.1-codex      | 6/10  | 11       |
```

**Variants**:
- `/parallel-review` — Full review with all configured models (can be 5+ models)
- `/parallel-review-lite` — Quick review with max 3 models (faster, cheaper)

**Commands**:
```bash
/parallel-review                          # Interactive picker
/parallel-review my-backend               # Jump to PR picker in that repo  
/parallel-review 42                       # Review PR #42 (asks which repo)
/parallel-review https://github.com/…/42  # Direct URL, skip all pickers
/parallel-review PROJ-123                 # Find PR by Jira ticket ID
/parallel-review-stop                     # Cancel a running review
```

**Performance**:
- **Time per agent**: 15-45s (single API call with embedded diff)
- **Total time**: ~30-60s (all models run in parallel)
- **Diff size limit**: 40k chars (auto-truncates larger diffs)
- **Timeout**: 3 minutes per agent

**Tip**: Use `/parallel-review-lite` for quick checks during development. Use `/parallel-review` for final pre-merge review.

### `/onboard`

**Purpose**: One-time project analysis and configuration generation.

**Flow**:
1. **Scan project structure** — Finds all repos in configured location
2. **Detect tech stack** — Identifies languages, frameworks, databases from config files:
   - Package managers (package.json, Gemfile, requirements.txt, go.mod, Cargo.toml, etc.)
   - Framework files (config/application.rb, mix.exs, tsconfig.json, etc.)
   - Database configs (schema.rb, migrations, Prisma schema, etc.)
3. **Identify testing patterns** — Finds test framework and conventions:
   - Test file locations and naming patterns
   - Factory/fixture patterns
   - Test commands from scripts or CI config
4. **Find linting setup** — Detects linters and formatters from config files
5. **Analyze git conventions** — Samples recent commits for message patterns and branch naming
6. **Detect CI/CD** — Reads GitHub Actions, GitLab CI, CircleCI configs
7. **Scan domain model** — Parses primary models and relationships
8. **Generate project.yml** — Creates configuration with detected conventions
9. **Generate memory files** — Creates DIRECTIVES.md, ARCHITECTURE.md, and per-repo files with initial knowledge

**When to run**: 
- First time setting up wyebot
- After major architectural changes
- When adding new repos to the project
- To refresh stale memory files

### `/flaky-test [test path]`

**Purpose**: Systematic diagnosis and fix of intermittent test failures.

**Flow**:
1. **Reproduce flakiness** — Runs the test 10-50 times to confirm intermittent behavior
2. **Collect failure patterns** — Records which runs fail and captures error messages
3. **Analyze root cause** — Examines common flaky test causes:
   - Race conditions and timing issues
   - Non-deterministic data (random values, timestamps)
   - Shared state between tests
   - External dependencies (network, filesystem)
   - Test order dependencies
4. **Propose fix** — Suggests one or more solutions based on diagnosis
5. **Implement fix** — Applies the chosen solution to the test
6. **Verify stability** — Runs the test many times to confirm flakiness is eliminated
7. **Document pattern** — Updates memory with the flaky pattern and fix for future reference

**Example**:
```
/flaky-test spec/models/user_spec.rb
/flaky-test tests/integration/checkout.test.ts
```

### `/rebase`

**Purpose**: Safe interactive rebase with PR awareness and conflict guidance.

**Flow**:
1. **Detect situation** — Determines:
   - Current branch and associated PR
   - Base branch (main/master)
   - How many commits ahead/behind
   - Whether conflicts are expected
2. **Show PR status** — Displays PR checks, reviews, and merge blockers
3. **Confirm rebase** — Asks for confirmation before starting (shows what will happen)
4. **Start rebase** — Executes `git rebase main` (or configured base branch)
5. **Guide conflict resolution** — If conflicts occur:
   - Shows conflicting files
   - Explains the conflict context
   - Suggests resolution strategy
   - Can apply fixes if approved
6. **Continue rebase** — Resumes after conflicts are resolved
7. **Verify result** — Runs tests if configured to ensure rebase didn't break anything
8. **Force push guidance** — Reminds about force-push and checks for coauthor coordination

**Safety features**:
- Never force-pushes automatically
- Checks for PR co-authors before suggesting force-push
- Offers abort option at any conflict
- Validates working directory is clean before starting

### `/qa-guide [ticket-id or PR]`

**Purpose**: Generate comprehensive manual testing guide from requirements and code changes.

**Flow**:
1. **Fetch ticket** — Gets acceptance criteria and description from Jira
2. **Find associated PR** — Locates PR linked to the ticket (via branch name or ticket key in PR title)
3. **Analyze code changes** — Reviews the PR diff to understand:
   - What features were added
   - What flows were modified
   - What edge cases exist in the code
4. **Extract test scenarios** — Identifies:
   - Happy path scenarios from acceptance criteria
   - Edge cases from code logic (validations, error handling)
   - Affected user flows
5. **Generate test plan** — Creates structured guide with:
   - **Preconditions**: Setup steps and test data needed
   - **Test steps**: Numbered step-by-step instructions
   - **Expected results**: What should happen at each step
   - **Edge cases**: Boundary conditions and error scenarios
   - **Regression checks**: Related features that might be affected
6. **Format for QA** — Outputs markdown or Notion-friendly format

**Example**:
```
/qa-guide PROJ-456
/qa-guide https://github.com/org/repo/pull/123
```

### `/learn [repo-name]`

**Purpose**: Review recent code changes and update memory with new patterns and conventions.

**Flow**:
1. **Determine context** — Checks if on a feature branch or main/master:
   - **Feature branch**: Analyzes your uncommitted and committed changes (your diff)
   - **Main/master**: Reviews recent commits (after `git fetch` or `git pull`)
2. **Load current memory** — Reads existing memory files for the repo
3. **Analyze changes** — Reviews commits/diff for:
   - New patterns or conventions
   - Architectural decisions
   - Code organization changes
   - New dependencies or integrations
   - Testing patterns
   - Bug fixes and gotchas
4. **Extract learnings** — Identifies what's worth remembering:
   - New conventions (naming, structure, patterns)
   - Technical decisions and rationale
   - Common pitfalls discovered
   - Integration details
5. **Update memory** — Modifies repo memory file:
   - Updates existing topics in-place if they exist
   - Adds new topics only when necessary
   - Keeps Quick Reference section up to date
6. **Summarize changes** — Shows what was learned and added to memory

**When to use**:
- After completing a major feature
- After team standup to learn from others' commits
- Before starting new work to refresh context
- To capture patterns from code review feedback

## Project Configuration (`project.yml`)

After running `/onboard`, your project configuration lives in `project.yml`:

```yaml
project:
  name: "My App"
  description: "E-commerce platform with microservices architecture"

repos:
  - name: my-backend
    path: ./my-backend
    type: primary
    stack: rails              # or: phoenix, express, fastapi, go, rust, etc.
  - name: my-frontend
    path: ./my-frontend
    type: service
    stack: react              # or: vue, svelte, angular, etc.

conventions:
  branch_format: "ticket-number/description"
  linter: "rubocop -A"             # or: "npx eslint --fix .", "mix format", "cargo fmt", etc.
  test_command: "bundle exec rspec" # or: "npx jest", "pytest", "go test ./...", "mix test", etc.
  pr_template: ".github/pull_request_template.md"
  merge_strategy: squash

agent:
  autonomy: mixed              # planning: confirmatory | autonomous | mixed
  git:
    create_branches: true      # create and switch branches
    commit: false              # git commit
    push: false                # git push
    create_pr: false           # create PRs via gh
  execution:
    run_tests: true            # run test suite
    run_linter: true           # run linter with auto-fix
    install_dependencies: false # npm install, bundle install, pip install, etc.
    run_migrations: false      # db:migrate, alembic upgrade, prisma migrate, etc.
  services:
    comment_on_prs: false      # leave comments on GitHub PRs
    update_jira: false         # modify Jira tickets
  guardrails: []               # additional free-text rules
  protected_files: []          # files the agent must never modify

jira:
  board_id: 42
  ticket_prefixes: ["PROJ", "BACK", "FRONT"]
  exclude_prefixes: ["OPS"]
```

This file is auto-generated by `/onboard` but fully editable. The agent reads it for:
- Which repos exist and where they are
- What commands to run for tests and linting
- Branch naming and commit conventions
- Autonomy flags — what the agent can and cannot do (git, execution, services)
- Jira board configuration

## Memory System

The agent maintains persistent knowledge in `memory/`:

```
memory/
├── DIRECTIVES.md       ← Project rules, conventions, coding standards
├── ARCHITECTURE.md     ← System architecture, domain model, patterns
└── repos/
    ├── my-backend.md   ← Per-repo knowledge (generated by /onboard)
    ├── my-frontend.md
    └── ...
```

### How it works

- **DIRECTIVES.md** and **ARCHITECTURE.md** are auto-injected into the agent's context at every turn.
- **Per-repo files** are loaded on-demand when the agent determines which repos are affected.
- Both files start with a **Quick Reference** section for rapid orientation.
- The agent updates memory after completing work — patterns, conventions, and gotchas accumulate over time.

### Topic-based organization

"Learned Patterns" and "Discovered Patterns" sections use topic headings (e.g., `### Authentication`, `### Testing Patterns`). The agent updates topics in-place instead of appending duplicates, keeping files concise.

### Cross-repo search

The `search_memory` tool searches across **all** memory files for a keyword. Useful for finding how other repos handle similar problems.

## Customizing wyebot

### Adding project-specific skills

Create a new skill in `.pi/skills/<skill-name>/SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does
---

# My Custom Skill

Instructions for the agent when this skill is invoked...
```

Then use it with `/skill:my-skill` or register a command shortcut in the extension.

### Modifying agent behavior

- **Guardrails**: Edit `agent.guardrails` in `project.yml`
- **Conventions**: Edit `conventions` in `project.yml`
- **Memory**: Edit files in `memory/` directly — the agent will respect your changes
- **System prompt**: Edit `.pi/AGENTS.md` for fundamental behavior changes

### Adding new commands

Edit `.pi/extensions/wyebot/index.ts` to register new commands via `pi.registerCommand()`.

## Credential Storage

Credentials are stored locally at `~/.pi/agent/` with restrictive permissions (0600):
- `jira-auth.json` — Jira credentials

These are **not** committed to the repo. Each team member configures their own.

## License

MIT
