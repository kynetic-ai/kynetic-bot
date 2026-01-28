---
name: meta
description: Manage session context - focus, threads, questions, and observations. Use when tracking what you're working on, managing parallel work streams, or capturing friction points.
---

# Meta - Session Context Management

Manage session continuity through focus, threads, questions, and observations.

## When to Use

- Starting work on a specific area (set focus)
- Tracking multiple parallel work streams (threads)
- Noting questions that need answers (questions)
- Capturing friction, successes, or ideas (observations)

## Focus Management

Focus tracks what you're currently working on.

```bash
# Set focus to current work area
kspec meta focus "implementing JSON output for all commands"

# View current focus
kspec meta focus

# Clear when done
kspec meta focus --clear
```

## Thread Management

Threads track parallel work streams.

```bash
# Add a new thread
kspec meta thread --add "investigating test failures"
kspec meta thread --add "refactoring output module"

# List threads
kspec meta thread --list

# Remove when done (0-based index)
kspec meta thread --remove 0
```

## Question Tracking

Track open questions that need answers.

```bash
# Add question
kspec meta question --add "Should validation happen at parse time or command execution?"

# List questions
kspec meta question --list

# Remove when answered
kspec meta question --remove 0
```

## Observations Workflow

Observations capture systemic patterns - friction, successes, questions, and ideas.

### Types of Observations

| Type | Purpose | Example |
|------|---------|---------|
| friction | Something harder than it should be | "Bulk updates require too many commands" |
| success | Pattern worth replicating | "Using --dry-run before derive prevented issues" |
| question | Systemic question | "When should agents use inbox vs tasks?" |
| idea | Improvement opportunity | "Could auto-generate AC from test names" |

### Creating Observations

```bash
# Friction point
kspec meta observe friction "No way to bulk-add acceptance criteria"

# Success pattern
kspec meta observe success "Using --dry-run before derive prevented duplicate tasks"

# Question about process
kspec meta observe question "When should agents enter plan mode vs just implement?"

# Idea for improvement
kspec meta observe idea "CLI could suggest next steps after task completion"
```

### Listing Observations

```bash
# All observations
kspec meta observations

# Only unresolved
kspec meta observations --pending-resolution

# With full details
kspec meta observations -v
```

### Promoting to Task

When an observation reveals actionable work:

```bash
kspec meta observations promote @ref --title "Add bulk AC command" --priority 2
```

### Resolving Observations

When addressed or no longer relevant:

```bash
kspec meta observations resolve @ref
```

## Where to Capture What

| What you have | Where to put it |
|---------------|-----------------|
| Vague idea for future | `inbox add` |
| Clear actionable work | `task add` |
| Something was hard | `meta observe friction` |
| Something worked well | `meta observe success` |
| Open question about work | `meta question --add` |
| Systemic process question | `meta observe question` |

**Rule of thumb:**
- **Inbox** = future work (becomes tasks eventually)
- **Questions** = session context (answer during work)
- **Observations** = systemic patterns (inform improvements)

## Session Patterns

### Starting a Focused Session

```bash
# 1. Get context
kspec session start

# 2. Set focus
kspec meta focus "working on documentation improvements"

# 3. Note any open questions
kspec meta question --add "Should skills duplicate AGENTS.md content?"
```

### Capturing Friction in the Moment

When you notice something is harder than it should be:

```bash
# Don't lose the thought - capture immediately
kspec meta observe friction "Had to run 5 commands to update one spec field"

# Continue with your work
# Review during /reflect
```

### End of Session

```bash
# Clear focus
kspec meta focus --clear

# Review and resolve any temporary questions
kspec meta question --list

# Observations persist for later triage
```

## Integration with Other Skills

- **`/triage`** - Processes observations alongside inbox items
- **`/reflect`** - Reviews what worked and what didn't, creates observations
- **`/kspec`** - Core task and spec workflows
