# Claude Instructions

@AGENTS.md

Read AGENTS.md for full project context and kspec usage patterns.

## Quick Start

```bash
# First: Get session context (active work, ready tasks, inbox)
kspec session start

# Get details on a specific task
kspec task get @task-slug

# When starting work
kspec task start @task-slug
kspec task note @task-slug "What you're doing..."

# When done (code complete, PR created)
kspec task note @task-slug "What was done, how, why..."
kspec task submit @task-slug

# After PR merged
kspec task complete @task-slug --reason "Summary"

# Create a new task
kspec task add --title "Task title" --spec-ref "@spec-item" --priority 2

# Capture ideas quickly (not yet tasks)
kspec inbox add "idea or random thought"
kspec inbox promote @ref --title "Task title"

# Validate spec files
kspec validate
```

## Important

1. **Use CLI, not manual YAML edits** - Always use `kspec task add`, `task note`, etc.
2. **Add notes** - Document what you do in task notes for future context
3. **Check dependencies** - Tasks have `depends_on` relationships; complete prerequisites first
4. **Spec is source of truth** - `.kspec/` defines what to build; code implements it

## Plan Mode Workflow

When a plan is approved, translate it to specs before implementing:

```bash
# 1. Create spec item under appropriate parent
kspec item add --under @parent --title "Feature Name" --type feature --slug feature-slug

# 2. Add acceptance criteria (repeat for each AC)
kspec item ac add @feature-slug --given "precondition" --when "action" --then "expected result"

# 3. Derive implementation task
kspec derive @feature-slug

# 4. Add implementation notes from plan to task
kspec task note @task-slug "Implementation approach: ..."

# 5. Begin implementation
kspec task start @task-slug
```

**Plans without specs are incomplete.** The spec with acceptance criteria IS the durable artifact.
