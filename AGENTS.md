# Kspec Agent Guide

This document provides context for AI agents working with kspec on this project.

## What is Kspec

Kspec is a specification and task management system. It provides:
- **Spec items** (`.kspec/modules/*.yaml`) - Define WHAT to build
- **Tasks** (`.kspec/*.tasks.yaml`) - Track the WORK of building
- **Inbox** (`.kspec/*.inbox.yaml`) - Capture ideas for later triage

The spec defines behavior. Tasks track implementation. They stay in sync through references.

## Shadow Branch Architecture

Kspec uses a shadow branch worktree to separate spec/task state from code:

- **Shadow branch** (`kspec-meta`): Stores all kspec state files
- **Worktree** (`.kspec/`): Git worktree pointing to shadow branch
- **Main branch**: Contains only code; gitignores `.kspec/`
- **Auto-commit**: All kspec operations automatically commit to shadow branch

This separation keeps code history clean while tracking spec/task changes.

```bash
# Initialize (first time after clone)
kspec init

# Check status
kspec shadow status

# Sync with remote
kspec shadow sync
```

## Key Concepts

### IDs: ULIDs + Slugs

Every item has:
- **ULID**: Canonical unique ID (e.g., `01JHNKAB01TASK100000000000`)
- **Slugs**: Human-friendly aliases (e.g., `add-auth-feature`)

References use `@` prefix: `@add-auth-feature` or `@01JHNKAB`

### Task States

```
pending -> in_progress -> pending_review -> completed
              |              |
          blocked <----------'
              |
          cancelled
```

**State transitions:**
- `kspec task start` -> `in_progress`
- `kspec task submit` -> `pending_review` (code done, awaiting merge)
- `kspec task complete` -> `completed` (from in_progress, pending, or pending_review)
- `kspec task block` -> `blocked`
- `kspec task unblock` -> `pending`
- `kspec task cancel` -> `cancelled`

### Notes (Work Log)

Tasks have append-only notes that track progress:
```yaml
notes:
  - _ulid: 01KEYRJ953HRYWJ0W4XEG6J9FB
    created_at: "2026-01-14T17:00:00Z"
    author: "@claude"
    content: |
      What was done and why...
```

Always add notes when completing significant work. This creates an audit trail.

## Task Workflow

### Starting a Session

Always begin by getting context:

```bash
kspec session start
```

This shows active work, recently completed tasks, ready tasks, inbox items, and git status.

### Working on Tasks

1. **Verify**: Before starting, check if work is already done
   - Check git history: `git log --oneline --grep="feature-name"`
   - Read implementation code if it exists
2. **Start**: Mark task in_progress before working
3. **Note**: Add notes as you work (not just at end)
4. **Submit**: Mark pending_review when code is done, PR created
5. **Complete**: Mark completed after PR merged

### Creating Work

- **Clear scope?** -> Create task directly
- **Unclear scope?** -> Add to inbox, triage later
- **Behavior change?** -> Check/update spec first, then derive task

## Session Context

Track focus, threads, questions, and observations to maintain continuity.

```bash
# Set focus before starting work
kspec meta focus "Implementing @task-slug"

# Capture friction as you encounter it
kspec meta observe friction "Command X failed when Y condition..."

# Capture successes for future reference
kspec meta observe success "Using pattern Z made refactoring much cleaner"

# Track parallel work
kspec meta thread add "Background: investigating performance issue"

# Capture open questions
kspec meta question add "Should we support legacy format in v2?"
```

## Observations System

Observations capture patterns that emerge during work:

| Type | Purpose | Example |
|------|---------|---------|
| friction | Things that didn't work | "Bulk updates require too many commands" |
| success | Patterns worth replicating | "Using --dry-run prevented issues" |
| question | Open decisions | "When should we validate?" |
| idea | Improvement opportunities | "Could auto-generate docs" |

**Observations vs Inbox:**
- **Observations** - Learning and reflection (friction, success, patterns)
- **Inbox** - Potential work (features, improvements to do later)

```bash
# Capture during work
kspec meta observe friction "Description..."

# Review later
kspec meta observations list

# Resolve when addressed
kspec meta resolve @observation-ref "How resolved"

# Promote to task if actionable
kspec meta promote @observation-ref --title "Task title"
```

## Spec-First Development

The spec defines behavior. Tasks track the work.

**Core principle**: If you're changing behavior and the spec doesn't cover it, update the spec first.

| Situation | Flow |
|-----------|------|
| Clear behavior change | Check spec -> Update/create spec -> Derive task |
| Vague idea | Capture in inbox -> Triage later -> Promote when ready |
| Infra/internal (no user impact) | Create task directly, no spec needed |
| Bug revealing spec gap | Fix bug -> Update spec to match reality |

## Staying Aligned During Work

Watch for scope expansion:
- Modifying files outside the original task
- "While I'm here..." thoughts
- Adding functionality the spec doesn't mention

Before modifying code outside your task:
1. Is this file part of my current task?
2. Does this have spec coverage?
3. Should I note this expansion?

When you notice drift after the fact:
1. Add a note to the task explaining what was added
2. Check for spec gaps
3. Commit the documentation update

## Commit Message Convention

Include task trailers in commits:

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

This enables `kspec log @ref` to find commits by task or spec.

## Code Annotations

Link code to acceptance criteria:

```typescript
// AC: @spec-item ac-N
it('should validate input', () => {
  // Test implementation
});
```

Every acceptance criterion should have test coverage with AC annotations.

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/kspec` | Task and spec management workflows |
| `/task-work` | Full task lifecycle - verify, start, note, submit, PR, complete |
| `/triage` | Systematic inbox and observation processing |
| `/meta` | Session context (focus, threads, questions, observations) |
| `/pr` | Create pull requests |
| `/reflect` | Session reflection and learning capture |
| `/spec` | Spec authoring - item types, acceptance criteria, traits |
| `/spec-plan` | Translate approved plans to specs with AC and derived tasks |

## Workflows

Workflows are structured process definitions in `.kspec/kynetic-bot.meta.yaml`. They provide step-by-step guidance for common processes.

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `@task-work-session` | manual | Full task lifecycle from start through PR merge |
| `@session-reflect` | session-end | Structured reflection to capture learnings |
| `@pr-review-merge` | pr-merge | Quality gates before merging PRs |
| `@inbox-triage` | session-start | Systematic inbox processing |

```bash
# Start a workflow
kspec workflow start @task-work-session

# Check current step
kspec workflow show

# Advance to next step
kspec workflow next
```

Workflows are advisory - they guide the process but don't enforce it.

## The Task Lifecycle Loop

### Implementation Iteration

1. `kspec session start` - get context, check for existing work
2. **Inherit existing work** - pending_review or in_progress tasks take priority
3. `kspec task start @task` - mark in_progress
4. Implement, add notes as you go
5. `kspec task submit @task` - mark pending_review when code done
6. `/pr` - create pull request
7. **EXIT** - iteration ends after PR creation

### PR Review (Separate Subagent)

Ralph spawns a PR review subagent for holistic review:
- Review changes broadly, not just task acceptance criteria
- Check for unintended side effects or scope creep
- Verify AC coverage: each criterion should have test with `// AC: @spec-item ac-N` annotation
- Check for inline AC comments linking code to acceptance criteria
- Verify code quality, maintainability, consistency
- After PR merged: `kspec task complete @task`
- Check for newly unblocked tasks to queue for next iteration

## Environment

- `KSPEC_AUTHOR` - Attribution for notes (e.g., @claude)
- Run `kspec setup` to configure

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `.kspec/` doesn't exist | Run `kspec init` |
| Worktree disconnected | Run `kspec shadow repair` |
| Running kspec from .kspec/ | Run from project root: `cd ..` |
| Sync conflicts | Run `kspec shadow resolve` |
