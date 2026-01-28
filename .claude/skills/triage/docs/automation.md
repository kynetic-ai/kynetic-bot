# Automation Triage

Assess and prepare tasks for automation eligibility. Goal: make tasks self-contained so they can be automated.

## Philosophy

- **Eligible is the goal** - Manual-only should be the exception
- **Criteria are for visibility** - Help identify what's missing
- **Fix issues, don't just assess** - Guide toward making tasks automatable

## Eligibility Criteria

A task is ready for automation when:
1. Has `spec_ref` pointing to resolvable spec
2. Spec has acceptance criteria (testable outcomes)
3. Task type is not `spike` (spikes output knowledge, not code)

## Workflow

### 1. Get Assessment Overview

```bash
# Show unassessed pending tasks with criteria status
kspec tasks assess automation

# See what auto mode would change
kspec tasks assess automation --auto --dry-run
```

### 2. Process Each Task

**If spike:**
- Mark `manual_only` - spikes are inherently human work
- `kspec task set @ref --automation manual_only --reason "Spike - output is knowledge"`

**If missing spec_ref or no ACs:**
- **Fix now:** Create spec, add AC, link task, re-assess
- **Mark for later:** `kspec task set @ref --automation needs_review --reason "..."`

**If has spec + ACs:**
- Review: Is the spec appropriate? Are ACs adequate?
- If yes: `kspec task set @ref --automation eligible`
- If no: Fix issues or mark `needs_review` with reason

## Quick Commands

```bash
# Assessment
kspec tasks assess automation              # Show unassessed with criteria
kspec tasks assess automation @ref         # Single task
kspec tasks assess automation --auto       # Apply obvious cases
kspec tasks assess automation --dry-run    # Preview changes

# Setting automation status
kspec task set @ref --automation eligible
kspec task set @ref --automation needs_review --reason "Why"
kspec task set @ref --automation manual_only --reason "Why"
kspec task set @ref --no-automation        # Clear to unassessed

# Filtering tasks
kspec tasks ready --unassessed             # Tasks needing assessment
kspec tasks ready --eligible               # Automation-ready tasks
kspec tasks ready --needs-review           # Tasks needing human triage
```

## Key Principles

- **CLI doesn't auto-mark eligible** - Requires agent/human review
- **Agents CAN mark eligible** - When reviewing based on user instruction
- **Add notes when setting status** - Document the "why"
- **Re-assess after fixes** - After adding spec/ACs, check again
