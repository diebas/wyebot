---
name: ticket
description: Main development workflow. Analyze a ticket, plan implementation across repos, implement changes, and add tests.
---

# Work on a Ticket

You are working on a development ticket.

## Input Required

Ask the user for:
1. **Ticket description**: What needs to be done (paste the ticket or describe it)
2. **Context**: Any additional context, constraints, or preferences
3. **Target repo(s)**: If known, which repo(s) this affects (or let the agent determine)

## Workflow

### Phase 1: Context Loading
Directives and Architecture are already in your system prompt (auto-injected).
1. Based on the ticket, identify which repo(s) will be affected.
2. Call the `load_repo_context` tool with the affected repo names to load repo-specific knowledge.
3. Review `project.yml` for conventions (branch format, test command, linter, guardrails).
4. Review the loaded context before proceeding to analysis.

### Phase 2: Analysis
1. **Determine repo placement**: If multiple repos exist, which repo should this change go in? Explain your reasoning. Check the project's `repo_structure` in project.yml for guidance (e.g., parent-forks, backend-frontend).
2. **Identify affected areas**: Which models, controllers, services, views, and tests will be touched?
3. **Check for existing patterns**: Look at how similar features are already implemented.
4. **Identify dependencies**: Does this require changes in multiple repos? What order should they be made?

### Phase 3: Implementation Plan
Present a clear plan to the user:

```
## Implementation Plan

### Affected Repositories
- [repo]: [reason]

### Changes Required
1. [File]: [What changes and why]
2. [File]: [What changes and why]
...

### Test Plan
- [What tests to add/modify]
- [Which existing tests to verify still pass]

### Risks / Considerations
- [Any risks or things to watch out for]
```

**Wait for user approval before proceeding** (unless agent autonomy is set to "autonomous" in project.yml).

### Phase 4: Implementation

**Before writing any code**, verify the current branch in each target repo:
```bash
cd <repo-dir>
git branch --show-current
```
- If the branch matches the ticket: proceed.
- If on a **different branch**: STOP. Alert the user — they may have switched context between messages. Ask before making any changes.
- If on **master/main**: Ask the user if they want to switch to the ticket branch or create it.
- **This check must happen on every new message**, not just at the start of the ticket. The developer may switch terminals or workflows between prompts.

Then proceed with implementation:
1. Make changes following the patterns already established in each repo.
2. Keep changes focused and minimal — don't refactor unrelated code.
3. Match existing code style exactly (indentation, naming, patterns).
4. If modifying multiple repos, clearly separate the changes.
5. Respect `protected_files` from project.yml — never modify those files.

### Phase 5: Testing
1. **Review existing tests** in the same area to understand patterns.
2. **Add new tests** that cover the implemented functionality.
3. **Maintain consistency**: Use the same factories, shared examples, and helper patterns already in use.
4. **Test types to consider**:
   - Model/unit specs for business logic
   - Controller/request specs for endpoints
   - System/integration specs for user-facing flows (if the feature is UI-heavy)
   - Service specs for extracted business logic
5. **Run the test suite** using the command from project.yml (`conventions.test_command`) to verify nothing is broken.

### Phase 6: Code Quality
1. Run the linter command from project.yml (`conventions.linter`) if configured.
2. Fix any auto-correctable issues and report remaining ones.

### Phase 7: Browser Verification (QA)
After implementation and tests pass, verify the feature/fix visually in the browser:

1. **Ensure the server is running**: Check if the server is up on the expected port. If not, remind the developer to start it.
2. **Generate a step-by-step QA guide**: Write a clear, numbered list of manual steps to test the feature/fix. Include:
   - Preconditions (user role, data setup, feature flags)
   - Exact navigation steps (URLs, clicks, form inputs)
   - Expected results at each step
   - Edge cases to verify
3. **Execute the QA steps in the browser**: Use the `browser` tool to walk through the testing steps:
   - Navigate to the relevant pages
   - Take screenshots at key checkpoints
   - Verify expected content is present (check HTML or screenshot)
   - Test both the happy path and error/edge cases
   - Test with different user roles if authorization is involved
4. **Report results**: Present a summary:
   ```
   ## QA Verification Results

   ### Steps Tested
   1. ✅ [Step description] — [what was verified]
   2. ✅ [Step description] — [what was verified]
   3. ❌ [Step description] — [what went wrong] (if any)

   ### Screenshots
   - [Key screenshot descriptions and paths]

   ### Notes
   - [Any observations, edge cases found, or things to watch]
   ```
5. **If issues are found**: Fix them and re-verify before moving on.

**Note**: If the browser tool is not available (Playwright not installed), skip automated browser testing but still generate the step-by-step QA guide for manual testing. Suggest running `/browser-setup` to enable automated testing.

**Note**: For features behind authentication, you may need the developer to log in manually first or provide session cookies. Ask if needed.

### Phase 8: Memory Update
After completing the work:
1. Update `memory/repos/<repo-name>.md` with any new patterns or learnings.
2. Update `memory/ARCHITECTURE.md` if architectural patterns were discovered.
3. Update `memory/DIRECTIVES.md` if new conventions should be followed.
4. Add entries to the "Discovered Patterns" or "Learned Patterns" sections using topic-based upsert.

## Important Rules

- **Respect autonomy flags** from project.yml — check `agent.git`, `agent.execution`, `agent.services` before performing any action. For example, don't commit if `git.commit` is false, don't push if `git.push` is false.
- **DO NOT** modify unrelated code or "improve" things not in the ticket.
- **DO** ask questions if the ticket is ambiguous.
- **DO** explain your reasoning when choosing where to place changes.
- **DO** show the implementation plan and wait for approval before coding (unless autonomy is "autonomous").
- **DO** always generate a QA testing guide at the end, even if browser testing is skipped.
