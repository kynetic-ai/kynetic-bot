---
name: reflect
description: Reflect on a session to identify learnings, friction points, and improvements. Captures valuable insights for future sessions.
---

# Session Reflection

Structured reflection to identify learnings and capture improvements.

## When to Use

- After completing significant work
- At the end of a session
- When you've encountered friction worth documenting

## Workflow Overview

1. **What Worked Well** - Identify effective practices
2. **Friction Points** - Where things were harder than needed
3. **Check Coverage** - Search specs/tasks/inbox for existing tracking
4. **Propose Improvements** - Concrete ideas for untracked friction
5. **Discussion** - Present to user, get approval one at a time
6. **Capture** - Add approved items to inbox/observations

## Step Details

### Step 1: What Worked Well

Identify practices that were effective:
- Workflows that flowed smoothly
- Tools/commands that helped
- Communication patterns that kept alignment
- Decisions that proved correct

*Be specific - "categorizing items first" not "good planning"*

### Step 2: Friction Points

Identify where things were harder than needed:
- Repetitive manual steps
- Missing commands or options
- Context loss or re-explanation
- Workarounds used

*Focus on systemic issues, not one-off mistakes*

### Step 3: Check Existing Coverage

Before proposing improvements, search ALL sources:

```bash
kspec search "<keyword>"  # Searches specs, tasks, AND inbox
```

For each friction point, note if it's:
- **Already tracked** - reference the existing item/task
- **Partially covered** - note what's missing
- **Not tracked** - candidate for capture

### Step 4: Propose Improvements

For untracked friction, propose concrete improvements:
- What it would do
- How it would help
- Rough scope (small/medium/large)

### Step 5: Discussion

Present findings to user. **Ask one at a time** about each improvement:
- Is this worth capturing?
- Any refinements to the idea?

### Step 6: Capture

Use appropriate destination:

```bash
# Actionable improvements (future work)
kspec inbox add "Description" --tag reflection --tag <area>

# Friction patterns (systemic issues)
kspec meta observe friction "Description"

# Success patterns (worth replicating)
kspec meta observe success "Description"

# Open questions
kspec meta question add "Question?"
```

## Where to Capture What

| What you found | Where to put it |
|----------------|-----------------|
| Actionable improvement idea | `inbox add` |
| Friction pattern (systemic) | `meta observe friction` |
| Success pattern | `meta observe success` |
| Open question needing research | `meta question add` |
| Bug or specific fix needed | `task add` |

## Reflection Prompts

Use these during steps 1-2:

**Process:** What pattern did I repeat 3+ times? What workarounds did I use?
**Tools:** What command/flag did I wish existed?
**Communication:** Where was the user surprised? What should I have asked earlier?
**Learning:** What do I know now that I didn't at session start?

## Key Principles

- **Specific over general** - "No bulk AC add" not "CLI could be better"
- **Systemic over incidental** - Focus on repeatable friction
- **Ask don't assume** - User decides what's worth capturing
- **Brief on successes** - Friction points are the value
