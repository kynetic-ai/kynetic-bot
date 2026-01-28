---
name: triage
description: Triage inbox items systematically. Analyzes items against spec/tasks, categorizes them, and processes using spec-first approach.
---

# Triage

Systematically process items: inbox, observations, or automation eligibility.

## Focus Modes

Use `/triage <mode>` to focus on a specific area:

| Mode | Purpose | Documentation |
|------|---------|---------------|
| `inbox` | Process inbox items -> specs/tasks | [docs/inbox.md](docs/inbox.md) |
| `observations` | Process pending observations | [docs/observations.md](docs/observations.md) |
| `automation` | Assess task automation eligibility | [docs/automation.md](docs/automation.md) |

Without a mode, follow the full triage session pattern below.

## Full Session Pattern

1. **Get context**
   ```bash
   kspec session start --full
   kspec inbox list
   kspec meta observations --pending-resolution
   ```

2. **Present overview to user**
   - Inbox items by category
   - Pending observations by type
   - Tasks needing triage

3. **Ask which focus area**

4. **Process that focus area**

5. **Repeat or stop** when user indicates

## Quick Start by Mode

### `/triage inbox`

Process inbox items using spec-first approach.

```bash
kspec inbox list
# For each item: delete, promote, or create spec first
kspec inbox delete @ref --force
kspec inbox promote @ref --title "..." --spec-ref @spec
```

### `/triage observations`

Process pending observations.

```bash
kspec meta observations --pending-resolution
# For each: resolve, promote to task, or leave
kspec meta observations resolve @ref
kspec meta observations promote @ref --title "..."
```

### `/triage automation`

Assess task automation eligibility.

```bash
kspec tasks assess automation
# Review criteria, fix issues, or mark status
kspec task set @ref --automation eligible
kspec task set @ref --automation needs_review --reason "..."
```

## Key Principles

- **Ask one question at a time** - Don't batch decisions
- **Spec before task** - Fill spec gaps before creating tasks
- **AC is required** - Specs without acceptance criteria are incomplete
- **Use CLI, not YAML** - All changes through kspec commands
- **Delete freely** - Outdated items should go
