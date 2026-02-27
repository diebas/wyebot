---
name: flaky-test
description: Diagnose and fix flaky (intermittent) test failures. Reproduces the flakiness by running the test multiple times, analyzes root causes, implements a fix, and verifies stability. Works with any test framework.
---

# Flaky Test Diagnosis & Fix

Systematically reproduce, diagnose, and fix intermittent test failures.

## Input Required

Ask the user for:
1. **Test file and/or case**: Path to the flaky test (e.g., `spec/models/user_spec.rb:42`, `src/__tests__/auth.test.ts`, `tests/test_login.py::test_session_timeout`).
2. **Repo**: Which repo the test is in. If only one repo is configured, use it automatically.
3. **CI output** (optional): If the user has CI failure output, ask them to paste it — it often contains the seed, error message, and backtrace.
4. **Known frequency** (optional): How often does it fail? (e.g., "1 in 5 runs", "only in CI", "random")

## Detecting the Test Framework

Before running anything, determine the test framework and how to run individual tests.

1. Check `project.yml` for `conventions.test_command` — this tells you the suite command.
2. Call `load_repo_context` for the repo — memory files may document test patterns.
3. Auto-detect the framework from the file path and repo structure:

| Indicator | Framework | Run single file | Run single test |
|-----------|-----------|----------------|-----------------|
| `spec/` dir, `*_spec.rb`, Gemfile has `rspec` | **RSpec** | `bundle exec rspec <file>` | `bundle exec rspec <file>:<line>` |
| `test/` dir, `*_test.rb`, Gemfile has `minitest` | **Minitest** | `bundle exec ruby -Itest <file>` | `bundle exec ruby -Itest <file> -n <test_name>` |
| `__tests__/`, `*.test.ts`, `*.test.js`, `*.spec.ts` | **Jest** | `npx jest <file>` | `npx jest <file> -t "<test_name>"` |
| `*.test.ts` with vitest in package.json | **Vitest** | `npx vitest run <file>` | `npx vitest run <file> -t "<test_name>"` |
| `tests/`, `*_test.py`, `test_*.py` | **pytest** | `pytest <file>` | `pytest <file>::<class>::<test>` |
| `*_test.go` | **Go test** | `go test ./<package>/...` | `go test ./<package>/... -run <TestName>` |
| `cypress/`, `*.cy.ts` | **Cypress** | `npx cypress run --spec <file>` | — |
| `*.spec.ts` with playwright in package.json | **Playwright Test** | `npx playwright test <file>` | `npx playwright test <file> -g "<test_name>"` |

4. If you can't determine the framework, ask the user:
   > **What command runs this specific test?** (e.g., `bundle exec rspec spec/models/user_spec.rb:42`)

## Workflow

### Phase 1: Context Loading

1. Call `load_repo_context` for the affected repo.
2. Navigate to the repo directory.
3. Check if any required services are running (database, etc.) based on repo memory.
4. Determine the test framework and the exact command to run the test (see table above).

### Phase 2: Reproduce the Flakiness

The goal is to confirm the test is actually flaky and capture a failure.

#### Step 1: Run the test once to see its current state

```bash
<run-single-test-command> # with verbose/documentation output if supported
```

#### Step 2: Run the test multiple times in a loop

Run 30+ iterations to catch intermittent failures. Use randomized order if the framework supports it:

**RSpec**: `--order rand`
**Jest**: `--randomize`
**pytest**: with `pytest-randomly` plugin or `--randomly-seed`
**Go**: `-count=1 -shuffle=on`
**Minitest**: supports random order by default

```bash
failures=0
for i in $(seq 1 30); do
  echo "=== Run $i ==="
  <run-single-test-command> [--random-order-flag] 2>&1 | tail -5
  if [ $? -ne 0 ]; then
    failures=$((failures + 1))
    echo "FAILED on run $i"
  fi
done
echo "Results: $((30 - failures))/30 passed, $failures/30 failed"
```

If the user provided a **seed** from CI, also try reproducing with that exact seed:

**RSpec**: `--seed <seed>`
**Jest**: `--seed=<seed>`
**pytest**: `--randomly-seed=<seed>`

#### Step 3: Run the test with surrounding context

Sometimes flakiness depends on other tests running first (shared state). Run the entire file:

```bash
<run-file-command> [--random-order-flag]
```

If the test passes in isolation but fails when run with the full file or suite, this points to **state leakage** between tests.

#### Step 4: Record results

Track:
- How many times it passed vs failed out of N runs
- Whether failures are consistent with a specific seed
- Whether it fails in isolation vs with other tests
- The exact error message and backtrace when it fails

Present findings:

```
## Reproduction Results

- **Test**: `<test identifier>`
- **Framework**: <detected framework>
- **Isolated runs**: 27/30 passed, 3/30 failed
- **Full file runs**: 22/30 passed, 8/30 failed
- **With CI seed**: ✅ passed / ❌ failed
- **Error**: `<error message>`
- **Pattern**: <observed pattern>
```

**If the test passes 30/30 times**: Inform the user it couldn't be reproduced locally. Ask if they want to:
- Try more iterations (50+)
- Try with the full test suite
- Look at the code anyway for potential issues
- Check for CI-specific environment differences (timing, resources, parallel execution)

### Phase 3: Root Cause Analysis

Read the failing test and all related code. Categorize the flakiness:

#### Category A: Timing / Async Issues
**Symptoms**: Element not found, timeout errors, assertions fire before async operations complete.

**Common in**: System/E2E tests (Capybara, Cypress, Playwright, Selenium), tests involving background jobs, WebSocket tests.

Check for:
- [ ] Missing waits after async operations (AJAX, fetch, WebSocket messages)
- [ ] Assertions that don't auto-retry (framework-specific — check memory files for known helpers)
- [ ] CSS animations or transitions delaying element interactivity
- [ ] Clicking or interacting before the page/component is fully loaded
- [ ] Arbitrary `sleep` calls — fragile, replace with explicit waits
- [ ] Race conditions between browser and server threads

#### Category B: Test Order Dependency (State Leakage)
**Symptoms**: Passes alone, fails when run with other tests. Different results with different seeds.

Check for:
- [ ] Global state mutation (class variables, module-level state, caches, singletons)
- [ ] Database records persisting across tests (setup in `before(:all)` / `beforeAll` / module-level fixtures)
- [ ] Environment variables set but not restored
- [ ] Mocked/stubbed functions not properly restored
- [ ] Shared file system state (temp files, uploads, logs)
- [ ] In-memory caches or registries not cleared between tests

#### Category C: Database / Concurrency Issues
**Symptoms**: Unique constraint violations, deadlocks, missing records, inconsistent reads.

Check for:
- [ ] Unique constraint collisions from factories/fixtures generating similar data
- [ ] Tests running in parallel sharing the same database
- [ ] Transaction isolation issues (server thread vs test thread seeing different data)
- [ ] Race conditions in tests that spawn threads or processes

#### Category D: Randomized Data Issues
**Symptoms**: Fails sporadically, no clear pattern related to ordering.

Check for:
- [ ] Random data generators (Faker, factory sequences) occasionally hitting edge cases
- [ ] Boundary values: empty strings, very long strings, special characters, unicode
- [ ] Ordering assumptions in assertions without explicit sort (`ORDER BY`, `.sort()`)
- [ ] Floating-point comparisons without tolerance
- [ ] Date/time-dependent logic near day boundaries or DST transitions

#### Category E: Environment Differences
**Symptoms**: Passes locally, fails in CI. Or vice versa.

Check for:
- [ ] CI resource constraints causing slower execution and timeouts
- [ ] Different timezone settings (CI often runs in UTC)
- [ ] Different screen size/resolution for browser tests
- [ ] Parallel test execution in CI (shared ports, files, DB)
- [ ] Missing services or different service versions in CI
- [ ] Different OS or dependency versions

### Present the Diagnosis

```
## Root Cause Analysis

**Category**: [A-E] — [Category name]

**Root Cause**: [Clear explanation of why the test fails intermittently]

**Evidence**:
- [Evidence point 1]
- [Evidence point 2]
- [Evidence point 3]

**Affected code**:
[Show the relevant test code with the problematic section highlighted]
```

### Phase 4: Implement the Fix

1. **Apply the minimal fix** that addresses the root cause. Don't refactor the entire test file — stay focused.
2. **Common fixes by category**:

   **A — Timing**: Add proper waits, use auto-retrying assertions, wait for specific conditions before interacting.

   **B — State leakage**: Isolate state, use per-test setup/teardown, add cleanup hooks.

   **C — Database**: Fix unique constraints in factories, add proper ordering, use per-test transactions.

   **D — Random data**: Constrain random generators, use fixed values for sensitive fields, use order-independent matchers.

   **E — Environment**: Increase timeouts for CI, set explicit timezone, fix viewport size, handle parallel execution.

3. **Run the linter** on the changed file (use the command from `project.yml` if configured).

### Phase 5: Verify the Fix

This is critical — a fix isn't proven until it survives many runs.

#### Step 1: Run the fixed test 30+ times

```bash
failures=0
for i in $(seq 1 30); do
  <run-single-test-command> [--random-order-flag] 2>&1 | tail -1
  if [ $? -ne 0 ]; then
    failures=$((failures + 1))
  fi
done
echo "Results: $((30 - failures))/30 passed, $failures/30 failed"
```

#### Step 2: Run the full test file with random order

```bash
for i in $(seq 1 10); do
  <run-file-command> [--random-order-flag] 2>&1 | tail -3
  if [ $? -ne 0 ]; then
    echo "FAILED on run $i"
  fi
done
```

#### Step 3: If the original CI seed was provided, verify with it

#### Step 4: Present verification results

```
## Verification Results

### Before Fix
- Isolated: 27/30 passed (10% failure rate)
- Full file: 22/30 passed (27% failure rate)

### After Fix
- Isolated: 30/30 passed ✅
- Full file: 10/10 passed ✅
- With CI seed: ✅ passed

**The fix is stable.** Ready for commit.
```

**If the fix doesn't fully resolve the flakiness** (still seeing failures):
- Go back to Phase 3 and look for additional root causes
- There may be multiple issues compounding
- Consider if the fix introduced a new timing window

### Phase 6: Summary & Memory Update

Present a final summary:

```
## Flaky Test Fix Summary

**Test**: `<test identifier>`
**Framework**: <framework>
**Root Cause**: <brief description>
**Fix**: <what was changed>
**Verification**: 30/30 isolated + 10/10 full file — all passing

**Files changed**:
- `<file>` (<what was changed>)
```

If the fix reveals a **new pattern** (e.g., a common flakiness source not yet documented), update the relevant memory files:
- `memory/DIRECTIVES.md` → "Learned Patterns" section (e.g., `### Testing` or a new topic)
- `memory/repos/<repo>.md` → "Testing Notes" or "Discovered Patterns" section

## Important Rules

- **DO NOT commit, push, or create PRs** unless `agent.git.commit` / `agent.git.push` is true in project.yml.
- **Always reproduce first.** Don't guess at fixes without confirming the flakiness.
- **Minimal fixes only.** Don't refactor the test or surrounding code beyond what's needed.
- **Verify thoroughly.** A "fix" that only ran once is not verified. Run 30+ times minimum.
- **If it can't be reproduced locally**: Say so clearly. Suggest CI-specific investigation. Don't apply speculative fixes.
- **If multiple tests are flaky**: Handle them one at a time. Each may have a different root cause.
- **Track the iteration count**: If you've been looping (reproduce → fix → verify) more than 3 times without success, pause and present findings to the user. The root cause may need human insight.
- **Check memory files**: The repo memory and directives may document known flakiness patterns, test helpers, or framework-specific gotchas. Always consult them before diving into analysis.
