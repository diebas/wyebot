---
name: recap
description: Summarize recent work sessions. Reads pi conversation history to show what you've been working on — tickets, PRs, discussions, and decisions.
---

# Recap Recent Work

Analyze recent pi conversation sessions and present a summary of what was worked on.

## Input

The user may provide:
- **Time range**: "today", "this week", "last 3 days", etc. Default: **today** (sessions from the current date).
- **Number of sessions**: "last 5 sessions", "last 10", etc. Alternative to time range.
- **Scope**: "all" (all pi working directories) or a specific project. Default: **current working directory sessions only**.

## Session File Location

Pi stores conversation sessions as JSONL files in:
```
~/.pi/agent/sessions/<encoded-cwd>/
```

Where `<encoded-cwd>` is the working directory path with `/` replaced by `--` and leading `--`.

To find sessions for the current project:
```bash
# List all session directories
ls ~/.pi/agent/sessions/

# Find the directory matching the current working directory
# The path is encoded: /Users/me/projects → --Users-me-projects--
```

## Session File Format

Each `.jsonl` file is one conversation session. Each line is a JSON object.

**Key fields:**
- `type: "session"` — Session metadata (first line), contains `timestamp` and `cwd`.
- `type: "message"` — A message in the conversation. Contains:
  - `message.role`: `"user"` or `"assistant"`
  - `message.content`: The message text (string or array of `{type: "text", text: "..."}` objects)
- `type: "tool_call"` — Tool invocations (contains `name` and `input` fields).
- `type: "tool_result"` — Tool results.

**Filename format**: `<ISO-timestamp>_<uuid>.jsonl` — the timestamp indicates when the session started.

## Workflow

### Step 1: Determine Scope and Time Range

Parse the user's input to determine:
1. **Which session directories** to scan (current project, all, or specific).
2. **Time filter**: Convert the user's request to a date range. Default is today.
3. **Session limit**: If the user asked for "last N sessions", use that instead of time.

### Step 2: Find Relevant Session Files

```bash
# List sessions sorted by modification time (most recent first)
ls -lt ~/.pi/agent/sessions/<directory>/*.jsonl
```

Filter by the determined time range or session count.

### Step 3: Extract Conversation Content

For each session file, extract the **user messages** to understand what was discussed. Also extract **assistant messages** selectively — specifically the first assistant response in each session (which often contains a plan or summary) and any messages that reference ticket IDs, PR numbers, or file paths.

Also look at **tool calls** for additional context. Tool calls are embedded inside assistant messages as content array items with `type: "toolCall"`:

Key tool calls to look for:
- `jira_ticket` → `input.ticketId` shows which tickets were fetched
- `bash` → `input.command` — look for `git`, `gh pr`, test commands
- `load_repo_context` → `input.repos` shows which repos were loaded
- `read`/`edit`/`write` → `input.path` shows which files were modified
- `browser` → indicates QA/verification was done

### Step 4: Analyze and Categorize

Group the extracted information into categories:

1. **Tickets / Features**: Any ticket IDs and what was done for each.
2. **Pull Requests**: PRs created, reviewed, or discussed (include number and repo).
3. **Code Reviews**: PRs reviewed, feedback given or received.
4. **Bug Fixes**: Issues found and resolved.
5. **Discussions / Decisions**: Important architectural or design decisions made.
6. **Tooling / Config**: Changes to the agent, skills, or project configuration.
7. **Learning / Research**: Things explored or researched without direct code changes.

For each item, note:
- **What**: Brief description of the work
- **Repo(s)**: Which repository was involved
- **Status**: Completed, in progress, or discussed only
- **Key decisions**: Any important decisions made during the session

### Step 5: Present the Summary

Format the output as a clear, scannable summary:

```
## 📋 Work Recap — [date range]

### 🎯 Tickets & Features
- **[TICKET-ID]**: [Description] — [status] ([repo])
  - [Key details, decisions, or blockers]

### 🔀 Pull Requests
- **[repo]#[number]**: [Title] — [created/reviewed/updated/merged]

### 🐛 Bug Fixes
- [Description] — [repo] — [status]

### 💬 Discussions & Decisions
- [Topic]: [What was decided and why]

### 🔧 Tooling & Config
- [What was changed and why]

### 📊 Session Stats
- Sessions analyzed: [N]
- Time range: [start] — [end]
- Repos touched: [list]
```

**Rules for the summary:**
- Be concise — one line per item with optional sub-bullets for key details.
- Use actual ticket IDs and PR numbers found in the sessions.
- If a ticket was worked on across multiple sessions, consolidate into one entry.
- Highlight any **blockers** or **pending items** that seem unfinished.
- If sessions span multiple projects/directories, group by project.
- Skip sessions that were trivially short.

### Step 6: Offer Follow-Up

After presenting the summary, offer:
> Would you like me to:
> 1. **Dive deeper** into any specific session or topic?
> 2. **Check status** of any mentioned tickets or PRs?
> 3. **Continue work** on any in-progress item?

## Important Notes

- **Read-only**: This skill only reads session files and presents information. It does NOT modify anything.
- **Privacy-aware**: Session files may contain sensitive information. Only summarize, don't dump raw content.
- **Performance**: For large session files (>500KB), focus on user messages and tool call names rather than reading every line.
- **Skill invocations**: Watch for lines where the user invokes skills (e.g., `/skill:ticket`, `/skill:pr-description`). These are strong signals of what was being done.
- **Consolidation**: If the same ticket appears in multiple sessions, merge the information chronologically.
