---
name: release-notes
description: Generate release notes by analyzing the latest tag in each configured repo, extracting deployed tickets, and building a summary table.
---

# Generate Release Notes

Create release notes by looking at what was actually deployed (tagged) in configured repos.

## Context

- Releases are identified by **git tags** in each repo.
- Commits between the latest tag and the previous tag represent what was deployed in that release.
- Ticket IDs are extracted from commit messages.
- This skill reads repo configuration from `project.yml`.

## Workflow

### Step 1: Determine Which Repos to Analyze

1. Read repos from `project.yml`.
2. If no repos are configured, ask the user which repos to check.
3. Ask the user if they want to analyze all repos or specific ones.

### Step 2: Analyze Tags in Each Repo

For each selected repo:

1. Navigate to the repo directory.
2. Fetch latest tags:
   ```
   git fetch --tags
   git tag --sort=-creatordate | head -5
   ```
3. Identify the **latest tag** and the **previous tag**.
4. Get the commits between them:
   ```
   git log <previous-tag>..<latest-tag> --oneline
   ```
5. Get the date of the latest tag:
   ```
   git log -1 --format=%ai <latest-tag>
   ```

If a repo has no tags or only one tag, note it and skip.

### Step 3: Extract Ticket IDs

From all commit messages across analyzed repos:

1. Extract Jira ticket IDs using the pattern: `[A-Z][A-Z0-9]+-\d+`.
2. If `jira.exclude_prefixes` is configured in `project.yml`, exclude tickets with those prefixes.
3. **Deduplicate**: A ticket may appear in multiple repos (e.g., shared changes merged into multiple forks). Count it only once.
4. Track which repos each ticket appeared in.

### Step 4: Fetch Ticket Details from Jira

For each unique ticket ID, use the `jira_ticket` tool to fetch its details (summary, type, description).

If Jira is not configured, work with commit messages only and note that descriptions will be limited.

### Step 5: Build the Table

Generate a tab-separated table:

**Ticket**: The Jira key.

**Title**: The Jira summary as-is.

**Type of change**: Classify based on the Jira issue type, labels, and summary:
- `Feature` — New user-facing functionality
- `Bug` / `Fix` — Bug fix
- `Tech Task` — Internal technical work
- `Task` — Non-feature work
- `Estimate` / `Refine` — Analysis tickets
- `Research` — Investigation tickets

**Requested by**: Analyze the ticket content to determine who benefits. Consider:
- If the change is in shared code and benefits all repos → "Everyone"
- If the change is specific to one repo/team → use the team/repo name
- Use ticket prefix and description for context

**UI Change**: "Yes" / "No" / "-" based on ticket content.

**Description**: Brief, non-technical 1-sentence summary.

### Step 6: Generate Output

First, show a summary header with:
- Release tag names and dates for each repo
- Total tickets deployed

Then output the tab-separated table inside a code block:

````
```
Ticket	Title	Type of change	Requested by	UI Change	Description
PROJ-123	Add user dashboard	Feature	Everyone	Yes	New dashboard showing key metrics.
PROJ-124	Fix login timeout	Fix	Support	No	Resolve session timeout on login.
...
```
````

**Rules:**
- Columns separated by TAB characters.
- First row is the header.
- Do NOT add commentary inside the code block.

After the table, add notes about:
- Which repos had releases and their tag names/dates
- Tickets that couldn't be found in Jira
- Any tickets that appeared in commits but seem unrelated (merge noise)

## Important Notes

- If Jira is not configured, tell the user to run `/jira-login` — but still generate what you can from commit messages.
- Keep descriptions concise — 1 short sentence max.
- When in doubt about a field, use "-".
- Watch for merge commits — they may contain tickets from multiple sources. Deduplicate carefully.
