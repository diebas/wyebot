---
name: sprint-notes
description: Generate sprint notes table from Jira sprint tickets, ready to paste into Notion.
---

# Generate Sprint Notes

Create sprint notes for a sprint by pulling tickets from Jira and generating a table ready to paste into Notion.

## Configuration

This skill reads from `project.yml`:
- **`jira.board_id`**: The Jira board ID to fetch sprints from. **Required** — if not set, ask the user.
- **`jira.exclude_prefixes`**: Ticket prefixes to exclude from sprint notes (e.g., `["OPS", "INFRA"]`).
- **`jira.ticket_prefixes`**: Known ticket prefixes for the project (used for categorization).

## Workflow

### Step 1: Determine Board ID
1. Read `jira.board_id` from `project.yml`.
2. If not set, ask the user:
   > **What is your Jira board ID?** (You can find it in the board URL: `.../board/<ID>`)
   > Tip: Set it in `project.yml` under `jira.board_id` to avoid being asked again.

### Step 2: Fetch Sprint Tickets
1. Use `jira_sprint` with the board ID and `sprint: "next"` to get all tickets from the next sprint.
2. If `jira.exclude_prefixes` is configured, exclude tickets with those prefixes.
3. For each remaining ticket, use `jira_ticket` to fetch its full description and details.

### Step 3: Analyze Each Ticket

For each ticket, determine these fields:

**Ticket**: The Jira key (e.g., PROJ-123).

**Title**: The Jira summary as-is.

**Type of change**: Classify based on the Jira issue type, labels, and summary:
- `Feature` — New user-facing functionality
- `Bug` / `Fix` — Bug fix
- `Tech Task` — Internal technical work (CI, refactoring, monitoring, dependencies)
- `Task` — Non-feature work (config changes, renaming, etc.)
- `Estimate` / `Refine` — Analysis and estimation tickets (look for "[Refine]", "[Analyze & estimate]" in title)
- `Research` — Investigation or research tickets

**Requested by**: Determine from ticket context. Use the ticket prefix, labels, or description to identify who requested it. If unclear, use "-".

**UI Change**: "Yes" if the ticket involves visible UI changes, "No" if it's backend/infrastructure only, "-" if unknown.

**Description**: Write a **brief, non-technical** 1-sentence summary of what the ticket does or its impact. Focus on the outcome, not the implementation. If the ticket has no description, use "-".

### Step 4: Generate Output

Output the sprint notes as a **tab-separated table** inside a code block. This format pastes directly into Notion as a table.

**CRITICAL OUTPUT FORMAT:**

````
```
Ticket	Title	Type of change	Requested by	UI Change	Description
PROJ-123	Add user dashboard	Feature	Product	Yes	New dashboard showing key metrics for users.
PROJ-124	Fix login timeout	Fix	Support	No	Resolve session timeout issue on login page.
...
```
````

**Rules:**
- Columns are separated by TAB characters (not spaces, not pipes).
- First row is always the header row.
- One ticket per row.
- The user will copy the content inside the code block and paste it into Notion.
- Do NOT add any commentary inside the code block — only the table.

After the code block, you may add notes about:
- Tickets that lacked enough context to summarize well
- Any observations about the sprint composition

## Important Notes
- If Jira is not configured, tell the user to run `/jira-login`.
- Keep descriptions concise — 1 short sentence max.
- When in doubt about a field, use "-".
