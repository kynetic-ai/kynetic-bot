---
name: task-work
description: Work on a kspec task with proper lifecycle - verify, start, note, submit, PR, complete.
---

# Task Work Session

Structured workflow for working on tasks. Full lifecycle from start through PR merge.

## When to Use

- Starting work on a ready task
- Ensuring consistent task lifecycle
- When you need to track progress with notes

## Inherit Existing Work First

**Before starting new work, check for existing in-progress or pending_review tasks.**

```bash
kspec session start  # Shows active work at the top
```

Priority order:
1. **pending_review** - PR awaiting merge, highest priority
2. **in_progress** - Work already started, continue it
3. **ready (pending)** - New work to start

**Always inherit existing work** unless user explicitly says otherwise.

## Task States

```
pending -> in_progress -> pending_review -> completed
```

- `task start` -> in_progress (working on it)
- `task submit` -> pending_review (code done, PR created, awaiting merge)
- `task complete` -> completed (PR merged)

## Workflow Overview

1. **Check Existing Work** - Inherit in_progress or pending_review tasks first
2. **Choose Task** - Select from ready tasks (if no existing work)
3. **Verify Not Done** - Check git history, existing code
4. **Start Task** - Mark in_progress
5. **Work & Note** - Add notes during work
6. **Commit** - Ensure changes committed with trailers
7. **Submit Task** - Mark pending_review
8. **Create PR** - Use /pr skill, then **EXIT**

After PR creation, this iteration ends. Ralph spawns a PR review subagent for holistic review.

### PR Review (Separate Session)

PR review is handled externally with broader focus than task completion:
- Review changes holistically, not just against acceptance criteria
- Check for unintended side effects or scope creep
- **Verify AC coverage**: each acceptance criterion should have a test with AC annotation
- **Check for inline AC comments**: `// AC: @spec-item ac-N` linking code/tests to criteria
- Verify tests cover actual behavior
- Consider code quality, maintainability, consistency

After PR merged: `kspec task complete @task --reason "Summary"`

## Key Commands

```bash
# See available tasks
kspec tasks ready

# Get task details
kspec task get @task-slug

# Start working (in_progress)
kspec task start @task-slug

# Add notes as you work
kspec task note @task-slug "What you're doing..."

# Submit for review (pending_review) - code done, PR ready
kspec task submit @task-slug

# Complete after PR merged (completed)
kspec task complete @task-slug --reason "Summary of what was done"
```

## Verification Step

Before starting, check if work might already be done:

```bash
# Check git history for related work
git log --oneline --grep="feature-name"
git log --oneline -- path/to/relevant/files

# If code/tests exist, VERIFY they actually work
# Review code against acceptance criteria
```

### Notes Are Context, Not Proof

Task notes provide historical context, but **never trust notes as proof of completion**. If a task is in the queue, validate independently:

- **"Already implemented"** -> Run the tests yourself
- **"Tests exist but skip in CI"** -> That's a gap to fix
- **"Work done in PR #X"** -> Verify the PR was merged AND correct

## Scope Expansion During Work

Tasks describe expected outcomes, not rigid boundaries. During work, you may discover:

- **Tests need implementation**: Implementing functionality is in scope if tests reveal it's missing
- **Implementation needs tests**: Add tests to prove it works

### When to Expand vs Escalate

**Expand scope** (do it yourself) when:
- The additional work is clearly implied by the goal
- It's proportional to the original task
- You have the context to do it correctly

**Escalate** (ask user) when:
- Scope expansion is major
- You're uncertain about the right approach

## Notes Best Practices

Add notes **during** work, not just at the end:

- When you discover something unexpected
- When you make a design decision
- When you encounter a blocker
- When you complete a significant piece

```bash
# Good: explains decision
kspec task note @task "Using retry with exponential backoff. Chose 3 max retries based on API rate limits."

# Bad: no context
kspec task note @task "Done"
```

## Commit Format

Include task trailer in commits:

```
feat: add user authentication

Implemented JWT-based auth with refresh tokens.

Task: @task-add-auth
Spec: @auth-feature

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## Submit vs Complete

**Submit** (`task submit`):
- Use when code is done and you're creating a PR
- Task moves to `pending_review`

**Complete** (`task complete`):
- Use only after PR is merged to main
- Task moves to `completed`

## After PR Creation (End of Iteration)

This iteration ends after creating the PR. Do NOT grab another task.

Ralph spawns a PR review subagent that:
1. Reviews the PR with holistic focus (not just task checklist)
2. Completes the task after PR is merged
3. Checks for unblocked tasks to queue for next iteration

## After Task Completion (PR Review Session)

After completing a task in the PR review session:

1. Check if other tasks were unblocked: `kspec tasks ready`
2. Queue next task for the next iteration (don't start immediately)
3. If work revealed new tasks/issues, add to inbox
