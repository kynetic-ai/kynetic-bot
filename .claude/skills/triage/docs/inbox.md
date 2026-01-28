# Inbox Triage

Process inbox items systematically: analyze, categorize, and convert to specs/tasks.

## Workflow

### 1. Gather Context

```bash
kspec session start --full
kspec inbox list
```

### 2. Categorize Items

Group inbox items by type:
- **Bugs** - implementation issues, errors
- **Spec gaps** - missing or incomplete specs
- **Quick wins** - small, well-defined improvements
- **Larger features** - need plan mode to design
- **Process/workflow** - meta improvements
- **Delete candidates** - outdated, duplicates, already done

### 3. Process Each Item

Decision tree:

```
Is it still relevant?
|-- No -> Delete: kspec inbox delete @ref --force
+-- Yes -> Does spec cover this?
         |-- No spec exists -> Create spec first
         |   +-- Small: item add + ac add
         |   +-- Large: Enter plan mode
         |-- Spec exists but incomplete -> Update spec (add AC)
         +-- Spec complete -> Promote to task
```

### 4. Spec-First Processing

For each behavior change:

1. **Check coverage**: `kspec item list | grep <relevant>`
2. **Identify gaps**: Does spec have description AND acceptance criteria?
3. **Update spec**:
   ```bash
   kspec item set @ref --description "..."
   kspec item ac add @ref --given "..." --when "..." --then "..."
   ```
4. **Derive or promote**:
   ```bash
   kspec derive @spec-ref           # If spec exists
   kspec inbox promote @ref --title "..." --spec-ref @spec  # If from inbox
   ```

## Quick Commands

```bash
# Triage decisions
kspec inbox delete @ref --force     # Remove irrelevant
kspec inbox promote @ref --title "..." --spec-ref @spec  # Convert to task

# Spec updates
kspec item set @ref --description "..."
kspec item ac add @ref --given "..." --when "..." --then "..."

# Create spec for gap
kspec item add --under @parent --title "..." --type requirement --slug slug

# Derive task from spec
kspec derive @spec-ref
```

## Key Principles

- **Ask one question at a time** - Use AskUserQuestion for decisions
- **Spec before task** - Fill spec gaps before creating tasks
- **AC is required** - Specs without acceptance criteria are incomplete
- **Use CLI, not YAML** - All changes through kspec commands
- **Delete freely** - Outdated or duplicate items should go
