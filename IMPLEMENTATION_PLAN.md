# Kynetic-Bot Implementation Plan

## Overview

Cross-platform chat bot using:
- **Kspec** for task/memory persistence (shadow branch)
- **Kynetic ACP** for agent execution
- **Moltbot-inspired** channel abstraction

## Package Structure

```
kynetic-bot/
├── packages/
│   ├── core/                       # Shared types and utilities
│   │   └── src/
│   │       ├── types/              # NormalizedMessage, SessionKey, ChannelAdapter
│   │       └── utils/              # session-key.ts, errors.ts, logger.ts
│   │
│   ├── messaging/                  # Message handling (@messaging module)
│   │   └── src/
│   │       ├── router.ts           # SessionKeyRouter
│   │       ├── transformer.ts      # MessageTransformer
│   │       ├── streaming.ts        # StreamCoalescer
│   │       └── history.ts          # ConversationHistory
│   │
│   ├── channels/                   # Platform adapters (@channels module)
│   │   └── src/
│   │       ├── registry.ts         # ChannelRegistry
│   │       ├── lifecycle.ts        # ChannelLifecycle
│   │       ├── dm-policy.ts        # DMPolicyManager
│   │       ├── media.ts            # MediaHandler
│   │       └── adapters/           # whatsapp.ts, discord.ts, slack.ts
│   │
│   ├── memory/                     # Persistent state (@memory module)
│   │   └── src/
│   │       ├── kspec-sync.ts       # KspecSync
│   │       ├── conversation.ts     # ConversationStorage
│   │       └── context-window.ts   # ContextWindowManager
│   │
│   ├── agent/                      # Agent orchestration (@agent module)
│   │   └── src/
│   │       ├── lifecycle.ts        # AgentLifecycle
│   │       ├── autonomous.ts       # AutonomousLoop
│   │       ├── skills.ts           # SkillsRegistry
│   │       ├── escalation.ts       # EscalationHandler
│   │       └── acp/                # Import from @kynetic/lifeline
│   │
│   └── bot/                        # Main application
│       └── src/
│           ├── bot.ts              # KyneticBot main class
│           ├── config.ts           # Configuration loading
│           └── cli.ts              # CLI entry point
```

## Implementation Phases

### Phase 0: Infrastructure (5 tasks)

| Task | Title | Complexity | Dependencies |
|------|-------|------------|--------------|
| 0.1 | Initialize pnpm monorepo workspace | 2 | None |
| 0.2 | Configure TypeScript project references | 2 | 0.1 |
| 0.3 | Set up Vitest with test utilities | 2 | 0.2 |
| 0.4 | Configure ESLint + Prettier | 1 | 0.1 |
| 0.5 | Copy kynetic ACP modules | 2 | 0.2 |

### Phase 1: MVP (7 tasks)

| Task | Title | Complexity | Dependencies |
|------|-------|------------|--------------|
| 1.1 | Core types, session keys, error utilities | 2 | 0.5 |
| 1.2 | SessionKeyRouter for @msg-routing | 2 | 1.1 |
| 1.3 | ChannelRegistry for @channel-registry | 2 | 1.1 |
| 1.4 | KspecSync for @mem-kspec-sync | 3 | 1.1 |
| 1.5 | AgentLifecycle for @agent-lifecycle | 3 | 1.1 |
| 1.6 | Discord channel adapter | 3 | 1.3 |
| 1.7 | Basic bot integration | 3 | 1.2, 1.3, 1.4, 1.5, 1.6 |

**Goal**: Basic message flow Discord -> Agent -> Discord with session persistence

### Phase 2: Core Features (6 tasks)

| Task | Title | Complexity | Dependencies |
|------|-------|------------|--------------|
| 2.1 | MessageTransformer for @msg-transform | 2 | 1.1 |
| 2.2 | DMPolicyManager for @channel-dm-policy | 3 | 1.3, 1.4 |
| 2.3 | ConversationStorage for @mem-conversation | 3 | 1.4 |
| 2.4 | SkillsRegistry for @agent-skills | 2 | 1.5 |
| 2.5 | ConversationHistory for @msg-history | 3 | 2.3 |
| 2.6 | Transform integration into bot | 2 | 2.1, 1.7 |

**Goal**: Message transformation, DM policies, conversation storage, skills, history

### Phase 3: Robustness (5 tasks)

| Task | Title | Complexity | Dependencies |
|------|-------|------------|--------------|
| 3.1 | StreamCoalescer for @msg-streaming | 3 | 1.1 |
| 3.2 | ChannelLifecycle for @channel-lifecycle | 3 | 1.3 |
| 3.3 | ContextWindowManager for @mem-context-window | 3 | 2.3, 2.5 |
| 3.4 | AutonomousLoop for @agent-autonomous | 3 | 1.5, 2.4 |
| 3.5 | Streaming integration into bot | 2 | 3.1, 1.7 |

**Goal**: Streaming, health monitoring, context management, autonomous mode

### Phase 4: Polish (4 tasks)

| Task | Title | Complexity | Dependencies |
|------|-------|------------|--------------|
| 4.1 | MediaHandler for @channel-media | 3 | 1.3 |
| 4.2 | EscalationHandler for @agent-escalation | 3 | 1.5 |
| 4.3 | End-to-end integration test suite | 3 | All |
| 4.4 | Additional channel adapters (WhatsApp/Slack) | 3 | 1.3 |

**Goal**: Media handling, human escalation, comprehensive testing, more platforms

---

## Detailed Task Specifications

### Phase 0: Infrastructure

#### Task 0.1: Initialize pnpm monorepo
**Files**: `package.json`, `pnpm-workspace.yaml`, `packages/*/package.json`
**AC**:
- pnpm workspace configured with all 6 packages
- Each package has package.json with name, main, types
- `pnpm install` succeeds from root

#### Task 0.2: Configure TypeScript
**Files**: `tsconfig.base.json`, `packages/*/tsconfig.json`
**AC**:
- Base config with strict mode, ES2022 target
- Project references for incremental builds
- Path aliases for `@kynetic-bot/*` imports
- `pnpm build` compiles all packages

#### Task 0.3: Set up Vitest
**Files**: `vitest.config.ts`, `packages/*/vitest.config.ts`, test utilities
**AC**:
- Vitest configured for each package
- Test utilities: mock factories, test fixtures
- `pnpm test` runs all tests
- Coverage reporting enabled

#### Task 0.4: Configure linting
**Files**: `eslint.config.js`, `.prettierrc`
**AC**:
- ESLint with TypeScript rules
- Prettier for formatting
- `pnpm lint` and `pnpm format` work

#### Task 0.5: Copy kynetic ACP modules
**Files**: `packages/agent/src/acp/*`
**AC**:
- Copy ACPClient, JsonRpcFraming, types from kynetic/lifeline/src/acp
- Adapt imports to local structure
- All copied modules compile without errors
- Document which files were copied and from where

### Phase 1: MVP

#### Task 1.1: Core types and utilities
**Files**: `packages/core/src/**`
**AC**:
- `NormalizedMessage`: text, sender, timestamp, channel, metadata
- `SessionKey`: agent, channel, peerKind, peerId segments
- `parseSessionKey("agent:main:whatsapp:user:+1234")` returns structured object
- `buildSessionKey({...})` returns formatted string
- Error types: `KyneticError` base, `UnknownAgentError`, `InvalidSessionKeyError`
- Unit tests for parsing edge cases (missing segments, invalid format)

#### Task 1.2: SessionKeyRouter (@msg-routing)
**Files**: `packages/messaging/src/router.ts`
**AC** (from spec):
- AC-1: Given message from WhatsApp user to agent, when router processes, then resolves to unique session key
- AC-2: Given existing session, when new message with same key, then appends to context
- AC-3: Given unknown agent, when router resolves, then returns UnknownAgentError
- Session store with get/create semantics
- Unit tests for all 3 AC

#### Task 1.3: ChannelRegistry (@channel-registry)
**Files**: `packages/channels/src/registry.ts`, `types.ts`
**AC** (from spec):
- AC-1: Given valid adapter, when register(), then added to registry
- AC-2: Given registered platform, when getAdapter(), then returns correct adapter
- AC-3: Given invalid adapter, when register(), then returns validation error with missing methods
- `ChannelAdapter` interface: name, sendMessage, parseIncoming, normalizeTarget
- Unit tests including invalid adapter validation

#### Task 1.4: KspecSync (@mem-kspec-sync)
**Files**: `packages/memory/src/kspec-sync.ts`
**AC** (from spec):
- AC-1: Given state change, when commitState(), then commits to shadow branch with timestamp
- AC-2: Given bot restart, when loadState(), then recovers all state from shadow branch
- AC-3: Given merge conflict, when detected, then applies strategy and logs resolution
- Uses kspec programmatic API or CLI
- Integration test with real .kspec worktree

#### Task 1.5: AgentLifecycle (@agent-lifecycle)
**Files**: `packages/agent/src/lifecycle.ts`, `acp/client-wrapper.ts`
**AC** (from spec):
- AC-1: Given session needs agent, when spawn(), then creates process with KYNETIC_* env vars
- AC-2: Given agent unresponsive, when health check fails, then terminates and respawns
- AC-3: Given session end, when cleanup(), then terminates gracefully with state save
- Import ACPClient from @kynetic/lifeline
- Use JsonRpcFraming for stdio
- Unit tests for lifecycle state transitions

#### Task 1.6: Discord adapter
**Files**: `packages/channels/src/adapters/discord.ts`
**AC**:
- Implements ChannelAdapter interface
- `parseIncoming(interaction)` extracts sender, text, attachments from Discord message
- `sendMessage(channelId, content)` sends via discord.js
- `normalizeTarget("user:123456")` handles Discord user/channel IDs
- Error handling: rate limits, permissions, API failures
- Integration test with mock Discord client

#### Task 1.7: Basic bot integration
**Files**: `packages/bot/src/bot.ts`, `config.ts`, `cli.ts`
**AC**:
- Given WhatsApp webhook, when received, then parses and routes to session
- Given routed message, when agent needed, then spawns via AgentLifecycle
- Given agent response, when ready, then sends via WhatsApp adapter
- Given agent error, when caught, then logs and returns error message to user
- Configuration loading with Zod validation
- E2E test: mock webhook -> mock agent -> mock send

### Phase 2: Core Features

#### Task 2.1: MessageTransformer (@msg-transform)
**Files**: `packages/messaging/src/transformer.ts`
**AC** (from spec):
- AC-1: Given platform message, when normalize(), then produces NormalizedMessage
- AC-2: Given normalized message, when denormalize(platform), then converts to platform format
- AC-3: Given unsupported type, when normalize(), then returns UnsupportedTypeError
- Transformer registry for adding platform transformers
- Unit tests for round-trip transformation

#### Task 2.2: DMPolicyManager (@channel-dm-policy)
**Files**: `packages/channels/src/dm-policy.ts`
**AC** (from spec):
- AC-1: Given pairing_required policy, when new user message, then creates pending request
- AC-2: Given pending request, when admin approves, then creates session and processes message
- AC-3: Given open policy, when user message, then creates session immediately
- AC-4: Given pending request, when rejected, then removes request and notifies user
- Pending requests stored in kspec notes
- Pairing codes with TTL (60 min default)
- Unit tests for all 4 AC

#### Task 2.3: ConversationStorage (@mem-conversation)
**Files**: `packages/memory/src/conversation.ts`
**AC** (from spec):
- AC-1: Given turn complete, when persist(), then appends note with timestamp
- AC-2: Given 50+ notes, when new turn, then triggers compaction
- AC-3: Given agent crash, when recover(), then loads from kspec notes
- Uses kspec note append API
- Compaction threshold configurable
- Integration tests with compaction

#### Task 2.4: SkillsRegistry (@agent-skills)
**Files**: `packages/agent/src/skills.ts`
**AC** (from spec):
- AC-1: Given startup, when discoverSkills(), then registers all available skills
- AC-2: Given capability request, when getSkill(), then returns appropriate tool
- AC-3: Given skill error, when executeSkill(), then catches and returns structured error
- Skill interface: name, capabilities[], execute()
- Unit tests for discovery and error handling

#### Task 2.5: ConversationHistory (@msg-history)
**Files**: `packages/messaging/src/history.ts`
**AC** (from spec):
- AC-1: Given session, when getHistory(), then returns messages chronologically
- AC-2: Given topic change, when boundary analysis, then marks semantic boundary
- AC-3: Given session timeout, when cleanup(), then archives and releases
- Boundary detection using semantic patterns
- Integration with ConversationStorage

#### Task 2.6: Transform integration
**Files**: `packages/bot/src/bot.ts`
**AC**:
- Given incoming message, when processed, then normalized before routing
- Given outgoing response, when sending, then denormalized for platform
- Given unknown content type, when detected, then logged and skipped gracefully

### Phase 3: Robustness

#### Task 3.1: StreamCoalescer (@msg-streaming)
**Files**: `packages/messaging/src/streaming.ts`
**AC** (from spec):
- AC-1: Given long response, when streaming, then delivers in chunks (minChars/idleMs)
- AC-2: Given client disconnect, when detected, then cleans up and logs
- AC-3: Given non-streaming platform, when response ready, then buffers complete
- Configurable minChars (1500 default), idleMs (1000 default)
- Unit tests for chunking and disconnect

#### Task 3.2: ChannelLifecycle (@channel-lifecycle)
**Files**: `packages/channels/src/lifecycle.ts`
**AC** (from spec):
- AC-1: Given start(), when called, then establishes connection and begins health monitoring
- AC-2: Given N health failures, when threshold exceeded, then marks unhealthy and reconnects
- AC-3: Given shutdown(), when called, then drains pending and closes cleanly
- Configurable health interval and failure threshold
- Unit tests for health check and reconnection

#### Task 3.3: ContextWindowManager (@mem-context-window)
**Files**: `packages/memory/src/context-window.ts`
**AC** (from spec):
- AC-1: Given new message, when approaching limit, then compacts older context
- AC-2: Given compaction, when executed, then preserves semantic boundaries
- AC-3: Given topic query, when retrieveContext(), then returns relevant archived context
- Token estimation (~4 chars per token)
- Soft (70%) and hard (85%) thresholds
- Uses semantic units from 2.5

#### Task 3.4: AutonomousLoop (@agent-autonomous)
**Files**: `packages/agent/src/autonomous.ts`
**AC** (from spec):
- AC-1: Given eligible tasks, when runLoop(), then processes autonomously
- AC-2: Given N consecutive errors, when threshold hit, then circuit breaker trips
- AC-3: Given cooldown elapsed, when half-open, then attempts single task
- Circuit breaker states: closed, open, half-open
- Uses kspec task polling
- Failure tracking with escalation

#### Task 3.5: Streaming integration
**Files**: `packages/bot/src/bot.ts`
**AC**:
- Given agent streaming response, when received, then passes through coalescer
- Given platform supports streaming, when chunks ready, then sends incrementally
- Given platform doesn't stream, when complete, then sends buffered response
- Given disconnect mid-stream, when detected, then cleans up properly

### Phase 4: Polish

#### Task 4.1: MediaHandler (@channel-media)
**Files**: `packages/channels/src/media.ts`
**AC** (from spec):
- AC-1: Given image message, when received, then extracts and stores with metadata
- AC-2: Given file to send, when preparing, then uploads and includes reference
- AC-3: Given oversized attachment, when validated, then rejects with error
- Size limits per platform (configurable)
- Unit tests for size validation

#### Task 4.2: EscalationHandler (@agent-escalation)
**Files**: `packages/agent/src/escalation.ts`
**AC** (from spec):
- AC-1: Given error, when escalate(), then notifies configured humans
- AC-2: Given acknowledgment, when received, then pauses agent and provides handoff
- AC-3: Given timeout, when elapsed, then follows configured fallback
- Configurable escalation channels
- Timeout and fallback state machine

#### Task 4.3: E2E integration test suite
**Files**: `packages/bot/test/integration/*.test.ts`
**AC**:
- Test: Full message flow (webhook -> route -> agent -> response)
- Test: Session persistence across bot restart
- Test: Streaming response delivery
- Test: Error escalation path
- Test: DM pairing approval flow
- All tests pass with mocks
- Optional: tests with real credentials (manual)

#### Task 4.4: Additional channel adapters
**Files**: `packages/channels/src/adapters/whatsapp.ts`, `slack.ts`
**AC**:
- WhatsApp adapter implements ChannelAdapter (Meta Cloud API)
- Slack adapter implements ChannelAdapter
- Both have normalizeTarget, parseIncoming, sendMessage
- Integration tests with mock APIs

---

## Reuse Strategy

### Copy from kynetic/lifeline/src/acp (Task 0.5)

| Component | Source File | Destination |
|-----------|-------------|-------------|
| ACPClient | `../kynetic/packages/lifeline/src/acp/client.ts` | `packages/agent/src/acp/client.ts` |
| JsonRpcFraming | `../kynetic/packages/lifeline/src/acp/framing.ts` | `packages/agent/src/acp/framing.ts` |
| ACP Types | `../kynetic/packages/lifeline/src/acp/types.ts` | `packages/agent/src/acp/types.ts` |

### Copy and adapt from kynetic/lifeline/src/session (Phase 3)

| Component | Source File | Adaptation |
|-----------|-------------|------------|
| SemanticUnits | `session/semantic-units.ts` | Context boundary detection |
| CompactionTrigger | `session/compaction-trigger.ts` | Token budget management |

---

## Decisions Made

1. **MVP Channel**: Discord (not WhatsApp) - simpler API, free, easy to test
2. **Agent Execution**: Local subprocess - spawn claude-code as child process
3. **Kynetic Access**: Copy source files - copy needed ACP modules into kynetic-bot

## Remaining Unknowns

### High Priority (blocks Phase 2+)

1. **Kspec API Approach**
   - Options: CLI spawning, direct YAML parsing, programmatic API
   - Affects: Task 1.4, 2.2, 2.3
   - Recommendation: Start with CLI spawning, refactor if needed

2. **Token Counting Strategy**
   - Options: Tiktoken, char estimation, model-specific
   - Affects: Task 3.3
   - Recommendation: Char estimation (~4 chars/token) initially

3. **Compaction/Summary Model**
   - Options: Same model as agent, smaller model, local
   - Affects: Task 2.3, 3.3
   - Recommendation: Same model for simplicity

### Medium Priority

4. **Media Storage**
   - Options: S3, local filesystem, kspec-managed
   - Affects: Task 4.1

---

## Verification

### Per-Phase Milestones

- **Phase 0**: `pnpm build && pnpm test && pnpm lint` all pass
- **Phase 1**: Send WhatsApp message, get agent response back
- **Phase 2**: DM pairing works, messages persist across restart
- **Phase 3**: Streaming works, agent crashes recover, autonomous loop runs
- **Phase 4**: Full test suite passes, multiple platforms work

---

## Summary

- **27 tasks** across 5 phases
- **Phase 0**: 5 tasks (infrastructure)
- **Phase 1**: 7 tasks (MVP)
- **Phase 2**: 6 tasks (core features)
- **Phase 3**: 5 tasks (robustness)
- **Phase 4**: 4 tasks (polish)

All tasks map to spec features with explicit AC. Tasks are scoped for Ralph automation (2-3 complexity average, clear scope, testable).
