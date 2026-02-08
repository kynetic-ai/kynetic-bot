# Kynetic Bot - Agent Guide

## What This Project Is

Kynetic Bot (`kbot`) is a **Discord bot framework using Claude as an AI agent via ACP (Agent Client Protocol)**. It's a pnpm monorepo with 7 packages:

- **core**: Shared types, logger, error classes, utilities
- **memory**: Shadow branch persistence (`.kbot/`), conversation/session storage
- **messaging**: Message routing, session management, context window, streaming
- **channels**: Discord adapter, media handling, tool call widgets
- **agent**: ACP client, autonomous loop, skills registry, escalation
- **bot**: Main orchestration — wires everything together, config, identity
- **supervisor**: Process spawn/respawn, checkpoint protocol

Uses **kspec** for spec/task management. Specs define bot behavior, tasks track implementation.

## Finding Information

AGENTS.md provides **project architecture, gotchas, and decision frameworks**. For detailed workflows and command syntax, use skills and CLI help:

| Need                                            | Where to look                                   |
| ----------------------------------------------- | ----------------------------------------------- |
| CLI command syntax                              | `kspec help <command>` or invoke `/kspec` skill |
| Task lifecycle (start → submit → PR → complete) | `/task-work` skill                              |
| Creating PRs                                    | `/pr` skill                                     |
| PR review and merge                             | `/pr-review` skill                              |
| Pre-PR quality checks                           | `/local-review` skill                           |
| Spec authoring (items, ACs, traits)             | `/spec` skill                                   |
| Plan-to-spec translation                        | `/spec-plan` skill                              |
| Spec implementation verification                | `/spec-review` skill                            |
| Session context (focus, threads, observations)  | `/meta` skill                                   |
| Inbox/observation processing                    | `/triage` skill                                 |
| Session reflection                              | `/reflect` skill                                |

Skills inject their full documentation when invoked — you don't need to memorize their contents.

## Quick Start

```bash
# Prerequisites: Node >=22, pnpm >=9

# Install and build
pnpm install && pnpm build

# Get session context
kspec session start
```

**Required env vars:**

- `DISCORD_TOKEN` — Discord bot token
- `AGENT_COMMAND` — Command to spawn agent (e.g., `claude -m opus-4`)

**Key optional env vars:**

- `KBOT_DATA_DIR` — Data directory (default: `.kbot`)
- `LOG_LEVEL` — debug, info, warn, error (default: `info`)
- `ESCALATION_CHANNEL` — Discord channel ID for escalation notifications

Use `kspec` for all spec/task commands.

## Essential Rules

1. **Use CLI, not manual YAML edits** — Never manually edit files in `.kspec/` or `.kbot/`. `.kspec/` changes are auto-committed by kspec CLI; `.kbot/` changes are auto-committed by the bot's runtime scheduler.
2. **Spec before code** — If changing behavior, check spec coverage. Update spec first if needed.
3. **Add notes** — Document what you do in task notes for audit trail.
4. **Check dependencies** — Tasks have `depends_on` relationships; complete prerequisites first.
5. **Always confirm** — Ask before creating or modifying spec items.
6. **Batch mutations** — Use `kspec batch` for 2+ sequential write operations (one atomic commit).

## Project Structure

```
kynetic-bot/
├── .kspec/                    # Spec/task state (shadow branch: kspec-meta)
│   ├── kynetic-bot.meta.yaml # Manifest, workflows, agents
│   ├── kynetic-bot.tasks.yaml # Active project tasks
│   ├── kynetic-bot.inbox.yaml # Inbox items
│   └── modules/              # Spec items by domain
├── .kbot/                     # Bot memory (shadow branch: kbot-memory)
│   ├── conversations/         # Conversation metadata + turn logs
│   ├── sessions/             # Session state
│   └── checkpoints/          # Supervisor restart checkpoints
├── packages/
│   ├── core/                 # Types, logger, errors, utils
│   ├── memory/               # Shadow branch, conversation/session persistence
│   ├── messaging/            # Message routing, session mgmt, streaming
│   ├── channels/             # Discord adapter, media, tool widgets
│   ├── agent/                # ACP client, autonomous loop, escalation
│   ├── bot/                  # Main orchestration (bin: kbot)
│   └── supervisor/           # Process spawn/respawn (bin: kbot-supervisor)
└── packages/*/test/          # Vitest unit tests per package
```

## Shadow Branch Architecture

This project has **two shadow branches** — don't confuse them.

1. **`.kspec/`** on orphan branch `kspec-meta` — spec/task state (development workflow)
2. **`.kbot/`** on orphan branch `kbot-memory` — bot conversations/sessions/checkpoints (runtime data)

Neither is a regular directory — both are **git worktrees** on orphan branches:

```
.kspec/.git → gitdir: .git/worktrees/-kspec → Shadow branch (kspec-meta)
.kbot/.git  → gitdir: .git/worktrees/-kbot  → Shadow branch (kbot-memory)
```

**Why:** Spec/task changes and bot runtime data don't clutter main branch history. Code PRs, spec changes, and bot data are tracked independently.

**How it works:** Every `kspec` command auto-commits to `kspec-meta`. Bot runtime auto-commits to `kbot-memory` on interval (5 min) or event threshold (100 events). Main branch gitignores both directories.

**Don't confuse the two.** `.kspec/` is for development workflow (kspec commands). `.kbot/` is for bot runtime data (conversations, sessions). Never manually edit either.

**CRITICAL: Always run kspec from project root, never from inside `.kspec/` or `.kbot/`.**

### Shadow Branch Commands

```bash
kspec shadow status   # Verify health
kspec shadow repair   # Fix broken worktree
kspec shadow sync     # Sync with remote
```

### Crash Recovery

If the bot crashes mid-write, a `.kbot-lock` file may exist. The bot auto-recovers on next start. Delete manually only if stale (no bot process running).

### Troubleshooting

| Issue                   | Fix                                                   |
| ----------------------- | ----------------------------------------------------- |
| `.kspec/` doesn't exist | `kspec init`                                          |
| `.kbot/` doesn't exist  | First bot run creates it, or create worktree manually |
| Worktree disconnected   | `kspec shadow repair`                                 |
| Sync conflicts          | `kspec shadow resolve`                                |
| Commands seem broken    | Check `pwd` — must be project root                    |

## Bot Architecture

### Message Flow

```
Discord → DiscordAdapter → NormalizedMessage → SessionKeyRouter
  → AgentLifecycle → ACP Prompt → Stream Updates → Discord
```

**SessionKeyRouter** maps messages to sessions using `{platform}:{channel}:{thread?}` keys. **StreamCoalescer** buffers streaming chunks into complete messages before sending to Discord.

### ACP (Agent Client Protocol)

The bot spawns an agent as a child process via `AGENT_COMMAND` and communicates over stdio JSON-RPC 2.0.

- Sessions have IDs (opaque strings), tracked by `ACPClient`
- Prompt sources: `'user'` for end-user messages, `'system'` for bot-generated context (default is `'system'`)
- **Gotcha**: Only one prompt per session at a time — concurrent prompts throw `session already prompting`
- Cancel is optional — falls back to SIGTERM if agent doesn't support `session/cancel`
- Package: `@agentclientprotocol/sdk@^0.13.1`

### Supervisor

The supervisor spawns the bot as a child process with an IPC channel:

- Restarts on non-zero exit with exponential backoff (1s → 60s max, 2x multiplier)
- **Clean exit (code 0) means intentional shutdown — supervisor exits too, no respawn**
- Checkpoint protocol: bot sends `planned_restart` via IPC → supervisor verifies checkpoint file → supervisor sends `restart_ack` → bot exits → supervisor respawns with `KBOT_CHECKPOINT_PATH` env → bot restores state → bot deletes consumed checkpoint
- Checkpoints have 24h TTL — stale ones are cleaned on supervisor startup
- Escalation: when backoff reaches max, emits `escalation` event and logs. External handler can notify `ESCALATION_CHANNEL` if configured

### Memory

- Conversations: YAML metadata + JSONL turn logs in `.kbot/conversations/`
- Auto-commit to shadow branch on interval (5 min) or event threshold (100 events)
- Timer uses `unref()` — won't keep process alive
- Recovery: on crash, recovers from last committed state on `kbot-memory` branch

## Key Concepts

### IDs and References

Every item has a ULID (canonical) and slug (human-friendly). References use `@` prefix: `@task-slug` or `@01JHNKAB`.

### Spec Items vs Tasks

- **Spec items** (`.kspec/modules/*.yaml`): Define WHAT to build
- **Tasks** (`.kspec/kynetic-bot.tasks.yaml`): Track the WORK of building

Tasks reference specs via `spec_ref`. They don't duplicate spec content.

### Task States

```
pending → in_progress → pending_review → completed
              ↓              ↓
          blocked ←──────────┘
              ↓
          cancelled
```

**State transitions:**

- `kspec task start` → `in_progress`
- `kspec task submit` → `pending_review` (code done, awaiting merge)
- `kspec task complete` → `completed` (from in_progress, pending, or pending_review)
- `kspec task block` → `blocked`
- `kspec task unblock` → `pending`
- `kspec task cancel` → `cancelled`

### Notes (Work Log)

Tasks have append-only notes that track progress:

```yaml
notes:
  - _ulid: 01KEYRJ953HRYWJ0W4XEG6J9FB
    created_at: '2026-01-14T17:00:00Z'
    author: '@claude'
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

See **Creating Work** under Spec-First Development for how to decide between tasks, inbox, and specs.

**For the full task lifecycle with PR creation, use `/task-work` skill.**

## Session Context & Observations

Track focus, threads, questions, and observations to maintain continuity:

```bash
kspec meta focus "Implementing @task-slug"
kspec meta observe friction "Command X failed when Y condition..."
kspec meta observe success "Using pattern Z made refactoring much cleaner"
kspec meta thread add "Background: investigating performance issue"
kspec meta question add "Should we support legacy format in v2?"
```

### Observation Types

| Type     | Purpose                    | Example                                  |
| -------- | -------------------------- | ---------------------------------------- |
| friction | Things that didn't work    | "Bulk updates require too many commands" |
| success  | Patterns worth replicating | "Using --dry-run prevented issues"       |
| question | Open decisions             | "When should we validate?"               |
| idea     | Improvement opportunities  | "Could auto-generate docs"               |

**Observations vs Inbox:**

- **Observations** — Learning and reflection (friction, success, patterns)
- **Inbox** — Potential work (features, improvements to do later)

**For detailed session context management, use `/meta` skill. For systematic triage, use `/triage` skill.**

## Spec-First Development

**Core principle**: If you're changing behavior and the spec doesn't cover it, update the spec first.

| Situation                       | Flow                                          |
| ------------------------------- | --------------------------------------------- |
| Clear behavior change           | Check spec → Update/create spec → Derive task |
| Vague idea, unclear scope       | Capture in inbox → Triage later               |
| Infra/internal (no user impact) | Create task directly, no spec needed          |
| Bug revealing spec gap          | Fix bug → Update spec to match reality        |

### Plan Mode Workflow

When a plan is approved, you MUST translate it to specs before implementing:

1. Create spec item: `kspec item add --under @parent --title "Feature" --type feature`
2. Add acceptance criteria: `kspec item ac add @spec --given "..." --when "..." --then "..."`
3. Derive task: `kspec derive @spec`
4. Add implementation notes to task
5. Begin implementation

**Plans without specs are incomplete.** The spec with ACs IS the durable artifact.

### Creating Work

- **Clear scope?** → Create task directly
- **Unclear scope?** → `kspec inbox add "idea"` → triage later with `/triage`
- **Learning/friction?** → `kspec meta observe friction "..."` → review with `/reflect`

## Staying Aligned During Work

**Watch for scope expansion:**

- Modifying files outside your current task
- Adding functionality the spec doesn't mention
- "While I'm here, I should also..." thoughts

**When you notice something outside your task:** Capture it separately (inbox item, new task, or observation). Add a note to your current task documenting what you found. Don't fix it inline — even small detours compound into drift. Stay on your task.

## PR Workflow

Before creating a PR, mark the task: `kspec task submit @ref` (transitions to `pending_review`).

The full PR lifecycle has three steps — **all required, in order:**

1. **`/local-review`** — Quality gates: AC coverage, test quality, test isolation. Run this FIRST.
2. **`/pr`** — Create the pull request.
3. **`/pr-review`** — Review and merge. Or `kspec workflow start @pr-review-merge`.

**Quality gates (never skip without explicit approval):**

- All CI checks passing
- All review comments addressed
- All review threads resolved
- AC coverage verified

**After merge:** `kspec task complete @ref --reason "Merged in PR #N. Summary..."`

**PR agent limitations:** Review subagent can't run kspec/npm — must delegate those to main agent.

## Commit Convention

Include task trailers in commits:

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref
```

Trailers enable `kspec log @ref` to find commits by task or spec.

## Code Annotations

Link tests to acceptance criteria:

```typescript
// AC: @spec-item ac-N
it('should validate input', () => { ... });
```

Every AC SHOULD have at least one test with this annotation.

## Ralph Loop Mode

When running in automated loop mode (ralph):

### The Loop

```
for each iteration:
  1. Ralph checks eligible tasks — if none, exits loop
  2. Agent works on tasks, may create PR(s)
  3. Agent stops responding (turn complete)
  4. Ralph sends reflection prompt
  5. Ralph processes pending_review via subagent
  6. Continue
```

**When you stop responding, ralph continues automatically.** Do NOT call `end-loop` after creating a PR.

### Task Inheritance

Priority: `pending_review` > `in_progress` > `pending`. Always inherit existing work before starting new tasks.

### Blocking Rules

**Block only for genuine external blockers:**

- Requires human architectural decision
- Needs spec clarification
- Depends on external API/service not available
- Formally blocked by `depends_on`

**Do NOT block for:**

- Task seems complex (do the work)
- Tests are failing (fix them)
- Service needs running (start it)
- Another task's PR is in CI (not a formal dependency)

**After blocking a task:**

```bash
kspec task block @task --reason "Reason..."
kspec tasks ready --eligible
# If tasks returned: work on next one
# If empty: stop responding — ralph auto-exits
```

**One blocked task is NOT "no more work."** `kspec tasks ready --eligible` output is authoritative.

## Running the Bot

**Required env:**

- `DISCORD_TOKEN` — Discord bot token
- `AGENT_COMMAND` — Command to spawn agent (e.g., `claude -m opus-4`)

**Optional env:**

- `KBOT_DATA_DIR` — Data directory (default: `.kbot`)
- `LOG_LEVEL` — debug, info, warn, error (default: `info`)
- `HEALTH_CHECK_INTERVAL` — Health check interval in ms (default: `30000`)
- `SHUTDOWN_TIMEOUT` — Graceful shutdown timeout in ms (default: `10000` for kbot, `30000` for kbot-supervisor)
- `ESCALATION_CHANNEL` — Discord channel ID for escalation notifications

**Commands:**

```bash
kbot              # Run bot directly
kbot-supervisor   # Run with supervisor (auto-restart)
```

**Scripts:**

```bash
pnpm build        # Build all packages
pnpm test         # Run all tests (vitest)
pnpm lint         # Lint all packages
```

**Gotchas:**

- `AGENT_COMMAND` is split by spaces — no shell quoting support. Use simple commands.
- Env number values must be strict integers (e.g., `HEALTH_CHECK_INTERVAL=30000` not `30s`).
- Escalation channel falls back to last active channel if `ESCALATION_CHANNEL` not configured.

## Workflows

Workflows are structured process definitions in `.kspec/kynetic-bot.meta.yaml`. They provide step-by-step guidance for common processes.

| Workflow             | Trigger        | Purpose                                                          |
| -------------------- | -------------- | ---------------------------------------------------------------- |
| `@task-work-session` | manual         | Full task lifecycle from start through PR merge                  |
| `@session-reflect`   | session-end    | Structured reflection to capture learnings                       |
| `@pr-review-merge`   | pr-merge       | Quality gates before merging PRs                                 |
| `@inbox-triage`      | session-start  | Systematic inbox processing                                      |
| `@local-review`      | manual         | Pre-PR quality enforcement: AC coverage, test quality, isolation |
| `@pr-review-loop`    | loop-pr-review | PR review subagent workflow for loop mode                        |

```bash
# Start a workflow
kspec workflow start @task-work-session

# Check current step
kspec workflow show

# Advance to next step
kspec workflow next
```

Workflows are advisory — they guide the process but don't enforce it.

## Troubleshooting

| Issue                      | Fix                                                                          |
| -------------------------- | ---------------------------------------------------------------------------- |
| `.kspec/` doesn't exist    | Run `kspec init`                                                             |
| Worktree disconnected      | Run `kspec shadow repair`                                                    |
| Running kspec from .kspec/ | Run from project root                                                        |
| Sync conflicts             | Run `kspec shadow resolve`                                                   |
| `.kbot/` doesn't exist     | First bot run creates it, or create worktree manually                        |
| `.kbot-lock` file exists   | Bot crashed mid-write. Auto-recovers on next start. Delete manually if stale |
| Bot won't start            | Check `DISCORD_TOKEN` and `AGENT_COMMAND` env vars                           |
| Supervisor respawn loop    | Check logs for crash reason. Fix root cause. Escalation fires at max backoff |
| Restart ACK timeout        | Supervisor didn't acknowledge checkpoint request. Check IPC channel          |
| Checkpoint rejected        | Supervisor couldn't read checkpoint file. Check file permissions and path    |

## Environment

- `KSPEC_AUTHOR` — Attribution for notes (e.g., @claude)
- Run `kspec setup` to configure
