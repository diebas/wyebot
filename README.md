# wyebot — AI Development Agent

A project-aware AI development agent built on [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Scans your codebase, learns your conventions, and helps you build, test, review, and ship — with persistent memory across sessions.

## What It Does

- **Smart project onboarding**: Scans your repos, detects tech stack, testing patterns, linting, CI, branch conventions — and configures itself automatically
- **Persistent memory system**: Maintains project knowledge across sessions (directives, architecture, per-repo learnings)
- **Multi-repo awareness**: Works across multiple repositories with understanding of their relationships
- **Jira integration**: Fetch tickets and sprint data directly from Jira Cloud
- **Sprint & release notes**: Auto-generates notes from Jira and git tags, ready to paste into Notion
- **Code review**: Multi-agent code review that spawns parallel AI reviewers and consolidates findings by consensus
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
/review-me                   # Multi-agent code review
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
| `/sprint-notes` | Generate sprint notes from Jira |
| `/release-notes` | Generate release notes from git tags |
| `/recap` | Summarize recent work sessions |
| `/flaky-test [test path]` | Diagnose and fix intermittent test failures |
| `/rebase` | PR-aware interactive rebase |
| `/review-me` | Multi-agent parallel code review |
| `/qa-guide` | Generate QA testing guide from ticket/PR |
| `/browser-setup` | Install Playwright for browser QA |
| `/browser-reset` | Reset browser session |
| `/memory` | Show memory files status |
| `/change-provider` | Switch AI provider and model |
| `/jira-login` | Configure Jira credentials |
| `/github-login` | Setup GitHub CLI authentication |

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
    stack: rails
  - name: my-frontend
    path: ./my-frontend
    type: service
    stack: react

conventions:
  branch_format: "ticket-number/description"
  linter: "rubocop -A"
  test_command: "bundle exec rspec"
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
    install_dependencies: false # bundle install, npm install, etc.
    run_migrations: false      # rails db:migrate, etc.
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
- Jira board configuration for sprint/release notes

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
