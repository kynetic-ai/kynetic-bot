/**
 * Bot Orchestration
 *
 * Main Bot class that wires together ChannelRegistry, AgentLifecycle,
 * SessionKeyRouter, and KbotShadow. Handles message flow from Discord
 * through agent processing to response delivery.
 *
 * @see @bot-orchestration
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { createLogger, TypedEventEmitter, type NormalizedMessage } from '@kynetic-bot/core';
import { ChannelRegistry, ChannelLifecycle, StreamingSplitTracker } from '@kynetic-bot/channels';
import {
  AgentLifecycle,
  type ToolCall,
  type ToolCallUpdate,
  type SessionUpdate,
} from '@kynetic-bot/agent';
import {
  SessionKeyRouter,
  MessageTransformer,
  StreamCoalescer,
  BufferedCoalescer,
  InMemorySessionStore,
  UnsupportedTypeError,
  MissingTransformerError,
  SessionLifecycleManager,
  ContextRestorer,
  ContextUsageTracker,
  type SummaryProvider,
  type StderrProvider,
  type SessionLifecycleEvents,
  type SessionState,
} from '@kynetic-bot/messaging';
import {
  KbotShadow,
  ConversationStore,
  SessionStore as MemorySessionStore,
  TurnReconstructor,
  type ConversationMetadata,
  type SessionEventInput,
} from '@kynetic-bot/memory';
import type { BotConfig } from './config.js';
import { buildIdentityPrompt } from './identity.js';
import { generateWakePrompt } from './wake.js';
import {
  readCheckpoint,
  deleteCheckpoint,
  writeCheckpoint,
  type Checkpoint,
  type WakeContext,
  type RestartReason,
} from '@kynetic-bot/supervisor';
import { getRestartProtocol } from './restart.js';

const DEFAULT_AGENT_READY_TIMEOUT = 30000;
const INFLIGHT_POLL_INTERVAL = 100;

/**
 * Error thrown when restart is requested but bot is not under supervisor
 *
 * AC: @bot-restart-api ac-6
 */
export class RestartNotAvailableError extends Error {
  constructor() {
    super('Restart not available - bot is not running under supervisor');
    this.name = 'RestartNotAvailableError';
  }
}

/**
 * Get the git repository root directory (memoized)
 * Falls back to cwd if not in a git repo
 *
 * Memoization avoids spawning multiple shell processes during Bot construction.
 *
 * AC: @bot-orchestration ac-7
 */
let cachedGitRoot: string | null = null;
function getGitRoot(): string {
  if (cachedGitRoot !== null) {
    return cachedGitRoot;
  }
  try {
    cachedGitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    cachedGitRoot = process.cwd();
  }
  return cachedGitRoot;
}

/**
 * Reset the cached git root (for testing only)
 * @internal
 */
export function _resetGitRootCache(): void {
  cachedGitRoot = null;
}

/**
 * Bot lifecycle state
 */
export type BotState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Escalation context emitted when agent escalates
 */
export interface EscalationContext {
  reason: string;
  metadata: Record<string, unknown>;
  targetChannel: string | null;
  timestamp: Date;
}

/**
 * Events emitted by Bot
 *
 * @trait-observable - Bot emits events for message lifecycle, errors, state changes,
 * session management, and tool execution.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Index signature required for TypedEventEmitter compatibility
export interface BotEvents extends Record<string, (...args: any[]) => void> {
  /** Message received from channel, before processing */
  'message:received': (msg: NormalizedMessage) => void;

  /** Message processing completed successfully */
  'message:processed': (msg: NormalizedMessage, durationMs: number) => void;

  /** Message processing failed with error */
  'message:error': (msg: NormalizedMessage, error: Error) => void;

  /**
   * Agent turn completed - emitted after agent response finishes
   *
   * Used by channel adapters for turn-based resource cleanup (e.g., placeholder messages).
   * Emitted before message:processed.
   *
   * @param sessionId - ACP session ID
   * @param channelId - Channel where the turn occurred
   *
   * AC: @discord-tool-widgets ac-23 - Clears placeholder tracking on turn end
   */
  'turn:end': (sessionId: string, channelId: string) => void;

  /** Tool call started - for channel adapters to display tool widgets */
  'tool:call': (
    sessionId: string,
    channelId: string,
    toolCall: ToolCall,
    parentMessageId: string | undefined
  ) => void;

  /** Tool call updated - for channel adapters to update tool widgets */
  'tool:update': (
    sessionId: string,
    channelId: string,
    toolCallUpdate: ToolCallUpdate,
    parentMessageId: string | undefined
  ) => void;

  /** Bot state changed */
  'state:change': (from: BotState, to: BotState) => void;

  /** Error occurred during bot operation */
  error: (error: Error, context: Record<string, unknown>) => void;

  /** Agent escalated to human */
  escalation: (context: EscalationContext) => void;

  /** Agent health status changed */
  'agent:health': (healthy: boolean, recovered: boolean) => void;

  /** Agent lifecycle state changed */
  'agent:state': (from: string, to: string) => void;

  /** New session created */
  'session:created': (data: { sessionKey: string; state: SessionState }) => void;

  /** Session rotated due to context limits */
  'session:rotated': (data: {
    sessionKey: string;
    oldSessionId: string;
    newState: SessionState;
  }) => void;

  /** Session recovered after agent restart */
  'session:recovered': (data: {
    sessionKey: string;
    state: SessionState;
    fromConversationId: string;
  }) => void;

  /** Context restoration failed during session recovery */
  'session:restore:error': (data: { sessionKey: string; error: string | Error }) => void;

  /** Context usage tracking error */
  'usage:error': (data: unknown) => void;

  /** Checkpoint consumed after wake context injection */
  'checkpoint:consumed': (data: { checkpointPath: string; sessionId: string }) => void;
}

/**
 * Options for Bot constructor (allows dependency injection for testing)
 */
export interface BotOptions {
  config: BotConfig;
  registry?: ChannelRegistry;
  agent?: AgentLifecycle;
  router?: SessionKeyRouter;
  shadow?: KbotShadow;
  /** SessionStore for agent session persistence (optional, auto-created if not provided) */
  memorySessionStore?: MemorySessionStore;
  /** ConversationStore for conversation persistence (optional, auto-created if not provided) */
  conversationStore?: ConversationStore;
  /** MessageTransformer for platform message normalization/denormalization (optional) */
  transformer?: MessageTransformer;
  /** SessionLifecycleManager for per-conversation session management (optional) */
  sessionLifecycle?: SessionLifecycleManager;
  /** ContextRestorer for session rotation/recovery context restoration (optional) */
  contextRestorer?: ContextRestorer;
  /** ContextUsageTracker for tracking context usage (optional) */
  contextUsageTracker?: ContextUsageTracker;
  /** SummaryProvider for context restoration summarization (optional, null disables) */
  summaryProvider?: SummaryProvider | null;
  /** Path to checkpoint file for restart context injection (optional) */
  checkpointPath?: string;
}

/**
 * Bot - Main orchestration class
 *
 * Coordinates:
 * - Channel adapters via ChannelRegistry/ChannelLifecycle
 * - Agent process via AgentLifecycle
 * - Message routing via SessionKeyRouter
 * - Memory persistence via KbotShadow
 *
 * @trait-observable - Emits events for message lifecycle, errors, and state changes
 * @trait-recoverable - Handles agent respawn and escalation
 * @trait-graceful-shutdown - Drains messages before stopping
 * @trait-health-monitored - Delegates to AgentLifecycle health monitoring
 */
export class Bot extends TypedEventEmitter<BotEvents> {
  private state: BotState = 'idle';
  private readonly config: BotConfig;
  private readonly registry: ChannelRegistry;
  private readonly agent: AgentLifecycle;
  private readonly router: SessionKeyRouter;
  private readonly shadow: KbotShadow;
  private readonly memorySessionStore: MemorySessionStore;
  private readonly conversationStore: ConversationStore;
  private readonly transformer: MessageTransformer;
  private readonly sessionLifecycle: SessionLifecycleManager;
  private readonly contextRestorer: ContextRestorer;
  private readonly contextUsageTracker: ContextUsageTracker;
  private channelLifecycle: ChannelLifecycle | null = null;

  private lastActiveChannel: string | null = null;
  private inflightCount = 0;
  private identityPrompt: string | null = null;
  private checkpoint: Checkpoint | null = null;
  private checkpointPath: string | null = null;
  private readonly log = createLogger('bot');

  /**
   * Track placeholders for streaming transformation
   *
   * When tool calls arrive before text response, the adapter creates a placeholder
   * message and registers it here via setPlaceholder(). When streaming starts,
   * consumePlaceholder() retrieves and removes it so we edit the placeholder
   * instead of sending a new message.
   *
   * Note: The Discord adapter has its own sessionPlaceholders Map that tracks
   * placeholders for reuse within a turn (deduplication). This Map is separate -
   * it's for the bot to know which message to edit when streaming begins.
   *
   * Cleanup: Entries are removed via consumePlaceholder() on normal flow, or
   * via clearPlaceholder() on turn:end for unconsumed entries.
   *
   * AC: @discord-tool-widgets ac-21
   */
  private readonly sessionPlaceholders = new Map<string, string>();

  /**
   * Private constructor - use Bot.create() factory
   */
  private constructor(options: BotOptions) {
    super();
    this.config = options.config;
    this.checkpointPath = options.checkpointPath ?? null;
    this.registry = options.registry ?? new ChannelRegistry();
    this.agent = options.agent ?? this.createAgentLifecycle();
    this.router = options.router ?? this.createRouter();
    // AC: @bot-orchestration ac-7 - uses git root for projectRoot
    // AC: @bot-config ac-6 - kbotDataDir is relative worktree dir name
    this.shadow =
      options.shadow ??
      new KbotShadow({
        projectRoot: getGitRoot(),
        worktreeDir: this.config.kbotDataDir,
      });

    // AC: @bot-storage-integration ac-1 - Instantiate memory stores
    const baseDir = path.join(getGitRoot(), this.config.kbotDataDir);
    this.memorySessionStore = options.memorySessionStore ?? new MemorySessionStore({ baseDir });
    this.conversationStore =
      options.conversationStore ??
      new ConversationStore({
        baseDir,
        sessionStore: this.memorySessionStore,
      });

    // AC: @transform-integration - MessageTransformer for platform normalization
    this.transformer = options.transformer ?? new MessageTransformer();

    // AC: @mem-session-lifecycle - Session lifecycle management components
    this.sessionLifecycle =
      options.sessionLifecycle ??
      new SessionLifecycleManager({
        rotationThreshold: 0.7,
        recentConversationMaxAgeMs: 30 * 60 * 1000, // 30 minutes
      });

    // AC: @mem-context-restore ac-9 - TurnReconstructor for content retrieval
    const turnReconstructor = new TurnReconstructor(this.memorySessionStore, {
      logger: this.log,
      summarizeTools: true,
    });
    this.contextRestorer =
      options.contextRestorer ??
      new ContextRestorer(options.summaryProvider ?? null, {
        logger: this.log,
        turnReconstructor,
      });

    this.contextUsageTracker =
      options.contextUsageTracker ??
      new ContextUsageTracker({
        timeout: 10000,
        debounceInterval: 30000,
      });

    this.setupAgentEventHandlers();
  }

  /**
   * Factory method to create and initialize a Bot instance
   *
   * AC-1: Bot.create() wires registry, agent lifecycle, session router, shadow
   * AC: @wake-injection ac-1 - Reads and validates checkpoint if provided
   *
   * @param config - Bot configuration
   * @returns Initialized Bot instance
   */
  static async create(
    config: BotConfig,
    options?: Partial<Omit<BotOptions, 'config'>>
  ): Promise<Bot> {
    const bot = new Bot({ config, ...options });

    // Initialize KbotShadow (creates .kbot/ if needed)
    await bot.shadow.initialize();

    // AC: @wake-injection ac-1 - Read and validate checkpoint if provided
    if (bot.checkpointPath) {
      const result = await readCheckpoint(bot.checkpointPath);
      if (result.success && result.checkpoint) {
        bot.checkpoint = result.checkpoint;
        bot.log.info('Checkpoint loaded for wake context injection', {
          sessionId: result.checkpoint.session_id,
          reason: result.checkpoint.restart_reason,
        });
      } else {
        // Log warning but continue without checkpoint
        bot.log.warn('Failed to load checkpoint, continuing without wake context', {
          path: bot.checkpointPath,
          error: result.error?.message,
          warning: result.warning,
        });
      }
    }

    return bot;
  }

  /**
   * Create Bot with injected dependencies (for testing)
   *
   * @param options - Bot options with optional dependency overrides
   * @returns Bot instance (not initialized)
   */
  static createWithDependencies(options: BotOptions): Bot {
    return new Bot(options);
  }

  /**
   * Start the bot
   *
   * Spawns the agent and begins accepting messages.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start from state: ${this.state}`);
    }

    this.transitionState('starting');
    this.log.info('Bot starting');

    try {
      // AC: @bot-identity ac-1 - Load identity prompt at startup
      const baseDir = path.join(getGitRoot(), this.config.kbotDataDir);
      this.identityPrompt = await buildIdentityPrompt(baseDir);
      this.log.info('Identity prompt loaded');

      // Spawn the agent
      await this.agent.spawn();

      // Wait for agent to be ready
      await this.ensureAgentReady();

      this.transitionState('running');
      this.log.info('Bot started successfully');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Bot start failed', { error: error.message });
      this.emit('error', error, { phase: 'start' });
      this.transitionState('idle');
      throw error;
    }
  }

  /**
   * Stop the bot gracefully
   *
   * AC-4: Graceful shutdown - stops channels, waits for in-flight, stops agent, shuts down shadow
   */
  async stop(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }

    this.transitionState('stopping');
    this.log.info('Bot shutdown initiated');

    try {
      // 1. Stop channel lifecycle (stops accepting new messages)
      if (this.channelLifecycle) {
        await this.channelLifecycle.stop();
      }

      // 2. Wait for in-flight messages
      await this.waitForInflightMessages(this.config.shutdownTimeout);

      // 3. End all active sessions
      for (const session of this.sessionLifecycle.getAllSessions()) {
        try {
          await this.memorySessionStore.updateSessionStatus(session.acpSessionId, 'completed');
          this.sessionLifecycle.endSession(session.sessionKey);
        } catch {
          this.log.warn('Failed to end session during shutdown', {
            sessionKey: session.sessionKey,
          });
        }
      }

      // 4. Stop agent gracefully
      await this.agent.stop();

      // 5. Shutdown shadow (final commit)
      await this.shadow.shutdown();

      this.transitionState('stopped');
      this.log.info('Bot shutdown complete');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Shutdown error', { error: error.message });
      this.emit('error', error, { phase: 'shutdown' });
      this.transitionState('stopped');
    }
  }

  /**
   * Get the current bot state
   */
  getState(): BotState {
    return this.state;
  }

  /**
   * Check if the bot is running
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Check if bot is running under supervisor
   *
   * AC: @bot-restart-api ac-7
   */
  isSupervisedMode(): boolean {
    return getRestartProtocol().isSupervised();
  }

  /**
   * Request a planned restart with checkpoint
   *
   * Writes checkpoint with session context, sends IPC message to supervisor,
   * and initiates graceful shutdown after acknowledgment.
   *
   * AC: @bot-restart-api ac-1 through ac-11
   *
   * @param options - Restart options
   * @param options.reason - Restart reason (default: 'planned')
   * @param options.wakePrompt - Prompt to inject on wake
   * @param options.pendingWork - Pending work description
   * @throws RestartNotAvailableError if not under supervisor
   */
  async requestRestart(options?: {
    reason?: RestartReason;
    wakePrompt?: string;
    pendingWork?: string;
  }): Promise<void> {
    // AC: @bot-restart-api ac-6
    if (!this.isSupervisedMode()) {
      throw new RestartNotAvailableError();
    }

    const reason = options?.reason ?? 'planned';

    // AC: @bot-restart-api ac-8, ac-11
    // Wait for any active streaming response to complete
    await this.waitForStreamingCompletion();

    // AC: @bot-restart-api ac-10
    // Get session context for checkpoint
    const sessionContext = this.getSessionContextForCheckpoint();

    // AC: @bot-restart-api ac-2, ac-3, ac-4
    // Build wake context
    const wakeContext: WakeContext = {
      prompt: options?.wakePrompt ?? 'Continuing after planned restart.',
    };
    if (options?.pendingWork) {
      wakeContext.pending_work = options.pendingWork;
    }

    // AC: @bot-restart-api ac-1
    // Write checkpoint
    const baseDir = path.join(getGitRoot(), this.config.kbotDataDir);
    const result = await writeCheckpoint(baseDir, sessionContext.sessionId, reason, wakeContext);

    // Check if write was successful
    if (!result.success || !result.path) {
      throw new Error(`Failed to write checkpoint: ${result.error?.message ?? 'Unknown error'}`);
    }

    const checkpointPath = result.path;

    this.log.info('Checkpoint written for restart', {
      checkpointPath,
      reason,
      sessionId: sessionContext.sessionId,
    });

    try {
      // AC: @bot-restart-api ac-1, ac-9
      // Send restart request and wait for ack (does not wait for full restart)
      await getRestartProtocol().requestRestart({
        checkpointPath,
      });

      this.log.info('Restart acknowledged by supervisor, initiating shutdown');

      // AC: @bot-restart-api ac-5
      // Initiate graceful shutdown
      await this.stop();
    } catch (err) {
      // Clean up checkpoint on failure
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await deleteCheckpoint(checkpointPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Handle an incoming message
   *
   * AC-2: Message flow - routes to session, prompts agent, sends response
   *
   * @param msg - Normalized message to process
   */
  async handleMessage(msg: NormalizedMessage): Promise<void> {
    if (this.state !== 'running') {
      this.log.warn('Message received while not running', { state: this.state });
      return;
    }

    // AC-6: Track for escalation fallback
    this.lastActiveChannel = msg.channel;
    this.inflightCount++;

    // @trait-observable: Emit message:received event
    this.emit('message:received', msg);
    const startTime = Date.now();

    // Send typing indicator while processing
    // This shows the user that the bot is working on their message
    if (this.channelLifecycle) {
      await this.channelLifecycle.startTypingLoop(msg.channel, msg.id);
    }

    try {
      // 1. Route to session
      const sessionResult = this.router.resolveSession(msg, 'main');
      if (!sessionResult.ok) {
        this.log.error('Routing failed', { error: sessionResult.error.message, messageId: msg.id });
        this.emit('error', sessionResult.error, { messageId: msg.id });
        return;
      }

      const sessionKey = sessionResult.value.key;
      let conversation: ConversationMetadata | undefined;

      // AC: @bot-storage-integration ac-2 - Get or create conversation
      // Note: User turn creation moved to after session lifecycle (needs session_id for event-sourced turns)
      try {
        conversation = await this.conversationStore.getOrCreateConversation(sessionKey);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error('Failed to get/create conversation', {
          error: error.message,
          messageId: msg.id,
        });
      }

      // 2. Ensure agent is healthy
      await this.ensureAgentReady();

      // 3. Get ACP client
      const client = this.agent.getClient();
      if (!client) {
        throw new Error('Agent client not available after ready check');
      }

      // 4. AC: @mem-session-lifecycle - Per-conversation session management
      const lifecycleResult = await this.sessionLifecycle.withLock(sessionKey, async () => {
        // Adapt SessionStore to SessionMemoryStore interface
        const sessionStoreAdapter = {
          createSession: async (params: {
            id: string;
            agent_type: string;
            conversation_id: string;
            session_key: string;
          }) => {
            await this.memorySessionStore.createSession({
              id: params.id,
              agent_type: params.agent_type,
              conversation_id: params.conversation_id,
              session_key: params.session_key,
            });
          },
          completeSession: async (sessionId: string) => {
            await this.memorySessionStore.updateSessionStatus(sessionId, 'completed');
          },
        };
        return await this.sessionLifecycle.getOrCreateSession(
          sessionKey,
          client,
          this.conversationStore,
          sessionStoreAdapter
        );
      });

      const { state: sessionState, isNew, wasRotated, wasRecovered } = lifecycleResult;
      const sessionId = sessionState.acpSessionId;
      let contextRestored = false;

      // AC: @bot-storage-integration ac-3 - Create session record if new session with conversation
      // SessionLifecycleManager creates session without conversation_id when there's no recovery,
      // so we need to create the session record here with the actual conversation_id
      if (isNew && !sessionState.conversationId && conversation) {
        this.sessionLifecycle.setConversationId(sessionKey, conversation.id);
        try {
          await this.memorySessionStore.createSession({
            id: sessionId,
            agent_type: 'claude',
            conversation_id: conversation.id,
            session_key: sessionKey,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log.error('Failed to create session record', {
            error: error.message,
            sessionId,
          });
        }
      }

      // AC: @mem-context-restore - Restore context on rotation or recovery
      if ((wasRotated || wasRecovered) && sessionState.conversationId) {
        try {
          const turns = await this.conversationStore.readTurns(sessionState.conversationId);
          if (turns.length > 0) {
            const restoration = await this.contextRestorer.generateRestorationPrompt(
              turns,
              sessionState.conversationId,
              path.join(getGitRoot(), this.config.kbotDataDir)
            );
            if (!restoration.skipped) {
              this.log.info('Injecting context restoration', {
                recentTurns: restoration.stats.recentTurns,
                summarizedTurns: restoration.stats.summarizedTurns,
              });
              await client.prompt({
                sessionId,
                prompt: [{ type: 'text', text: restoration.prompt }],
                promptSource: 'system',
              });
              contextRestored = true;
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log.warn('Context restoration failed, continuing without', { error: error.message });
          this.emit('session:restore:error', { sessionKey, error });
        }
      }

      // AC: @wake-injection ac-2, ac-3, ac-9 - Inject wake prompt BEFORE identity prompt
      // Message order: wake context, then identity prompt, then restored history
      if (isNew && !contextRestored && this.checkpoint) {
        const wakePrompt = generateWakePrompt(this.checkpoint.wake_context);
        this.log.info('Injecting wake context prompt', {
          sessionId,
          checkpointSessionId: this.checkpoint.session_id,
          reason: this.checkpoint.restart_reason,
        });
        await client.prompt({
          sessionId,
          prompt: [{ type: 'text', text: wakePrompt }],
          promptSource: 'system',
        });

        // AC: @wake-injection ac-6 - Delete checkpoint and emit event after consumption
        if (this.checkpointPath) {
          await deleteCheckpoint(this.checkpointPath);
          this.emit('checkpoint:consumed', {
            checkpointPath: this.checkpointPath,
            sessionId: this.checkpoint.session_id,
          });
          this.log.info('Checkpoint consumed and deleted', {
            path: this.checkpointPath,
          });
        }

        // Clear checkpoint after consumption (one-time use)
        this.checkpoint = null;
        this.checkpointPath = null;
      }

      // AC: @bot-identity ac-1, ac-2 - Send identity prompt for new sessions WITHOUT prior history
      // AC: @wake-injection ac-7 - Send identity only if no checkpoint
      // AC: @wake-injection ac-9 - Identity sent AFTER wake context
      // Don't send if context was restored (would be redundant)
      if (isNew && !contextRestored && this.identityPrompt) {
        this.log.debug('Sending identity prompt to new session');
        await client.prompt({
          sessionId,
          prompt: [{ type: 'text', text: this.identityPrompt }],
          promptSource: 'system',
        });
      }

      // 5. Set up streaming response delivery
      // AC: @streaming-integration ac-1, ac-2, ac-3
      const isStreamingPlatform = this.supportsStreaming(msg.sender.platform);
      let responseText = '';
      let streamingMessageId: string | undefined;
      // AC: @discord-channel-adapter ac-7 - Track message blocks for multi-block streaming
      // Empty string chunks signal block boundaries in Claude's streaming API
      let blocks: string[] = [];
      let currentBlockText = '';
      let coalescer: StreamCoalescer | BufferedCoalescer;

      // AC: @discord-channel-adapter ac-5, ac-6 - StreamingSplitTracker for preemptive splitting
      const splitTracker = isStreamingPlatform ? new StreamingSplitTracker() : null;

      // AC: @mem-agent-sessions ac-8, ac-9 - Event queue for session.update events
      // Events are queued synchronously in updateHandler, flushed after coalescer.complete()
      const eventQueue: SessionEventInput[] = [];
      let promptEventSeq: number | undefined;
      let firstAgentEventSeq: number | undefined;
      let lastAgentEventSeq: number | undefined;

      if (isStreamingPlatform && this.channelLifecycle) {
        // AC-2: Streaming platform - use StreamCoalescer for incremental delivery
        coalescer = new StreamCoalescer({
          minChars: 1500,
          idleMs: 1000,
          onChunk: async () => {
            if (!this.channelLifecycle) return;
            // AC: @discord-channel-adapter ac-7 - Display all finalized blocks + current block
            // Block boundaries are handled in updateHandler, not here
            const displayText = [...blocks, currentBlockText].filter(Boolean).join('\n\n');
            if (!displayText) return;

            // AC: @discord-channel-adapter ac-5, ac-6 - Check for split decision
            const decision = splitTracker?.push(displayText);

            if (decision?.action === 'split' && streamingMessageId) {
              // Split needed - edit current message with first chunk, send overflow as new messages
              const [firstChunk, ...overflowChunks] = decision.chunks;

              // Edit the current message with the first chunk
              await this.channelLifecycle.editMessage?.(
                msg.channel,
                streamingMessageId,
                firstChunk
              );

              // Send overflow chunks as new messages
              for (const overflow of overflowChunks) {
                const result = await this.channelLifecycle.sendMessage(msg.channel, overflow);
                // Update streamingMessageId to point to the latest message for future edits
                if (result?.messageId) {
                  streamingMessageId = result.messageId;
                }
              }

              // Reset state for continuation - new message starts fresh
              blocks = [];
              currentBlockText = '';
              splitTracker?.reset();
            } else if (!streamingMessageId) {
              // First actual content - check for placeholder to transform
              // AC: @discord-tool-widgets ac-21 - Edit placeholder instead of sending new message
              const placeholderId = this.consumePlaceholder(sessionId, msg.channel);
              if (placeholderId) {
                // Transform placeholder into response by editing it
                await this.channelLifecycle.editMessage?.(msg.channel, placeholderId, displayText);
                streamingMessageId = placeholderId;
                this.log.debug('Transformed placeholder into response', {
                  sessionId,
                  channelId: msg.channel,
                  messageId: placeholderId,
                });
              } else {
                // No placeholder - send initial message and capture ID for edits
                const result = await this.channelLifecycle.sendMessage(msg.channel, displayText, {
                  replyTo: msg.id,
                });
                streamingMessageId = result?.messageId;
              }
              // Stop typing indicator once we start sending response
              this.channelLifecycle.stopTypingLoop(msg.channel);
            } else {
              // Normal update - edit existing message with accumulated text
              await this.channelLifecycle.editMessage?.(
                msg.channel,
                streamingMessageId,
                displayText
              );
            }
          },
          onComplete: async (fullText) => {
            // AC: @discord-channel-adapter ac-7 - Finalize any remaining block
            if (currentBlockText.trim()) {
              blocks.push(currentBlockText);
              currentBlockText = '';
            }
            // Join all blocks with double newline for final display
            const finalDisplayText = blocks.filter(Boolean).join('\n\n');
            responseText = finalDisplayText || fullText;

            // AC: @discord-channel-adapter ac-5 - Handle final split if needed
            const finalChunks = splitTracker?.finalize() ?? (responseText ? [responseText] : []);

            if (this.channelLifecycle && streamingMessageId && finalChunks.length > 0) {
              // Edit current message with first chunk
              await this.channelLifecycle.editMessage?.(
                msg.channel,
                streamingMessageId,
                finalChunks[0]
              );

              // Send any overflow chunks as new messages
              for (let i = 1; i < finalChunks.length; i++) {
                await this.channelLifecycle.sendMessage(msg.channel, finalChunks[i]);
              }
            }
          },
          onError: (error) => {
            this.log.error('Stream error', { error: error.message, messageId: msg.id });
            return Promise.resolve();
          },
          logger: this.log,
        });
      } else {
        // AC-3: Non-streaming platform - buffer complete response
        coalescer = new BufferedCoalescer(async (fullText) => {
          responseText = fullText;
          if (this.channelLifecycle && fullText) {
            await this.channelLifecycle.sendMessage(msg.channel, fullText, {
              replyTo: msg.id,
            });
            // Stop typing indicator once we start sending response
            this.channelLifecycle.stopTypingLoop(msg.channel);
          }
        }, this.log);
      }

      // 6. Set up update handler to feed chunks through coalescer
      // AC: @mem-agent-sessions ac-8 - Queue session.update events for all ACP SessionUpdates
      const updateHandler = (_sid: string, update: SessionUpdate) => {
        // Queue session.update event for persistence (flushed after coalescer.complete())
        eventQueue.push({
          type: 'session.update',
          session_id: sessionId,
          data: { update_type: update.sessionUpdate, payload: update },
        });

        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          const text = update.content.text ?? '';

          // AC: @discord-channel-adapter ac-7 - Block boundary detection
          // Empty string signals block boundary in Claude's streaming API
          if (text === '' && isStreamingPlatform) {
            // Finalize current block if it has content
            if (currentBlockText.trim()) {
              blocks.push(currentBlockText);
              currentBlockText = '';
            }
            // Don't push empty string to coalescer - it's just a boundary signal
            return;
          }

          // Accumulate text into current block for streaming platforms
          if (isStreamingPlatform) {
            currentBlockText += text;
          }

          if (coalescer instanceof StreamCoalescer) {
            // AC-1: Pass through coalescer for streaming
            coalescer.push(text).catch((err: unknown) => {
              this.log.error('Error pushing to coalescer', { error: err });
            });
          } else {
            coalescer.push(text);
          }
        }

        // AC: @discord-tool-widgets - Emit tool call events for channel adapters
        // When sessionUpdate is 'tool_call', the update object IS the ToolCall (with sessionUpdate added)
        // AC: @discord-tool-widgets ac-10, ac-11, ac-14 - Pass parentMessageId for thread isolation
        if (update.sessionUpdate === 'tool_call') {
          this.emit(
            'tool:call',
            sessionId,
            msg.channel,
            update as ToolCall & { sessionUpdate: string },
            streamingMessageId
          );
        }

        // When sessionUpdate is 'tool_call_update', the update object IS the ToolCallUpdate
        // AC: @discord-tool-widgets ac-10, ac-11, ac-14 - Pass parentMessageId for thread isolation
        if (update.sessionUpdate === 'tool_call_update') {
          this.emit(
            'tool:update',
            sessionId,
            msg.channel,
            update as ToolCallUpdate & { sessionUpdate: string },
            streamingMessageId
          );
        }
      };
      client.on('update', updateHandler);

      try {
        // AC: @mem-agent-sessions ac-9 - Log prompt.sent event before sending to agent
        const promptEvent = await this.memorySessionStore.appendEvent({
          type: 'prompt.sent',
          session_id: sessionId,
          data: { content: msg.text },
        });
        promptEventSeq = promptEvent.seq;

        // 7. Send prompt to agent and wait for completion
        await client.prompt({
          sessionId,
          prompt: [{ type: 'text', text: msg.text }],
          promptSource: 'user',
        });

        // 8. Complete the coalescer to flush any remaining buffered content
        await coalescer.complete();

        // 9. Flush event queue and capture sequence numbers for turn creation
        // AC: @mem-agent-sessions ac-8 - Persist full SessionUpdate as session.update events
        for (const eventInput of eventQueue) {
          const event = await this.memorySessionStore.appendEvent(eventInput);
          if (firstAgentEventSeq === undefined) {
            firstAgentEventSeq = event.seq;
          }
          lastAgentEventSeq = event.seq;
        }
      } catch (err) {
        // AC-4: Abort coalescer on error/disconnect
        if (coalescer instanceof StreamCoalescer) {
          coalescer.abort();
        }
        throw err;
      } finally {
        client.off('update', updateHandler);
      }

      // AC: @mem-conversation ac-1 - Append user turn with event pointer
      // AC: @bot-storage-integration ac-2 - User turn persisted
      if (conversation && promptEventSeq !== undefined) {
        try {
          await this.conversationStore.appendTurn(conversation.id, {
            role: 'user',
            session_id: sessionId,
            event_range: { start_seq: promptEventSeq, end_seq: promptEventSeq },
            message_id: msg.id,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log.error('Failed to persist user turn', {
            error: error.message,
            messageId: msg.id,
          });
        }
      }

      // AC: @mem-conversation ac-2 - Append assistant turn with event pointer
      // AC: @bot-storage-integration ac-4 - Assistant turn persisted
      if (
        conversation &&
        firstAgentEventSeq !== undefined &&
        lastAgentEventSeq !== undefined &&
        responseText
      ) {
        try {
          await this.conversationStore.appendTurn(conversation.id, {
            role: 'assistant',
            session_id: sessionId,
            event_range: { start_seq: firstAgentEventSeq, end_seq: lastAgentEventSeq },
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log.error('Failed to persist assistant turn', {
            error: error.message,
            messageId: msg.id,
          });
        }
      }

      // AC: @mem-context-usage - Track context usage for rotation decisions (async, non-blocking)
      // AgentLifecycle implements StderrProvider via onStderr() method
      this.contextUsageTracker
        .checkUsage(sessionId, client, this.agent as unknown as StderrProvider)
        .then((usage) => {
          if (usage) {
            this.sessionLifecycle.updateContextUsage(sessionKey, usage);
          }
        })
        .catch((err) => {
          // AC: @mem-session-lifecycle ac-7 - Continue with stale data on usage errors
          const error = err instanceof Error ? err : new Error(String(err));
          this.log.warn('Usage check failed, continuing with stale data', { error: error.message });
        });

      // Clean up any unconsumed placeholders for this turn
      // AC: @discord-tool-widgets ac-21 - Memory cleanup for placeholder tracking
      this.clearPlaceholder(sessionId, msg.channel);

      // Emit turn:end for channel adapter cleanup (e.g., placeholder messages)
      // AC: @discord-tool-widgets ac-23 - Clears placeholder tracking on turn end
      this.emit('turn:end', sessionId, msg.channel);

      // @trait-observable: Emit message:processed event
      this.emit('message:processed', msg, Date.now() - startTime);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Message handling failed', { error: error.message, messageId: msg.id });
      // @trait-observable: Emit message:error event
      this.emit('message:error', msg, error);
    } finally {
      // Stop typing indicator when processing completes
      this.channelLifecycle?.stopTypingLoop(msg.channel);
      this.inflightCount--;
    }
  }

  /**
   * Handle a raw platform-specific message
   *
   * Normalizes the message using the registered platform transformer,
   * then delegates to handleMessage.
   *
   * AC: @transform-integration ac-1 - Incoming messages normalized before routing
   * AC: @transform-integration ac-3 - Unknown content types logged and skipped
   *
   * @param platform - Platform identifier (e.g., 'discord', 'slack')
   * @param raw - Raw platform-specific message
   */
  async handleRawMessage(platform: string, raw: unknown): Promise<void> {
    // AC-1: Normalize incoming message
    const result = this.transformer.normalize(platform, raw);

    if (!result.ok) {
      // AC-3: Log and skip gracefully for unknown/unsupported content
      if (result.error instanceof UnsupportedTypeError) {
        this.log.warn('Unsupported content type - skipping message', {
          platform,
          errorCode: result.error.code,
        });
        return;
      }

      if (result.error instanceof MissingTransformerError) {
        this.log.warn('No transformer registered for platform - skipping message', {
          platform,
        });
        return;
      }

      // Other normalization errors
      this.log.error('Message normalization failed', {
        platform,
        error: result.error.message,
      });
      return;
    }

    // Delegate to main handler
    await this.handleMessage(result.value);
  }

  /**
   * Register a platform transformer
   *
   * @param transformer - Platform transformer to register
   */
  registerTransformer(transformer: Parameters<MessageTransformer['registerTransformer']>[0]): void {
    this.transformer.registerTransformer(transformer);
  }

  /**
   * Get the message transformer instance
   *
   * Allows external code to register transformers or check capabilities.
   */
  getTransformer(): MessageTransformer {
    return this.transformer;
  }

  /**
   * Check if a platform supports streaming responses
   *
   * AC: @streaming-integration ac-2 - Platform streaming capability detection
   *
   * Discord supports streaming via message edits.
   * Other platforms may have limited or no streaming support.
   *
   * @param platform - Platform identifier
   * @returns true if platform supports streaming
   */
  supportsStreaming(platform: string): boolean {
    // Discord supports streaming (can edit messages)
    // Other platforms typically don't support incremental updates
    return platform === 'discord';
  }

  /**
   * Set the channel lifecycle for sending responses
   *
   * @param lifecycle - Channel lifecycle instance
   */
  setChannelLifecycle(lifecycle: ChannelLifecycle): void {
    this.channelLifecycle = lifecycle;
  }

  /**
   * Get the number of in-flight messages
   */
  getInflightCount(): number {
    return this.inflightCount;
  }

  /**
   * Get the last active channel (for escalation fallback)
   */
  getLastActiveChannel(): string | null {
    return this.lastActiveChannel;
  }

  /**
   * Register a placeholder message for a session+channel
   *
   * Called by channel adapters when they create a placeholder message for
   * early tool calls (before text response starts). When streaming begins,
   * the bot will edit this placeholder instead of creating a new message.
   *
   * AC: @discord-tool-widgets ac-21 - Placeholder becomes response message
   *
   * @param sessionId - ACP session ID
   * @param channelId - Channel where placeholder was created
   * @param messageId - ID of the placeholder message
   */
  setPlaceholder(sessionId: string, channelId: string, messageId: string): void {
    const key = `${sessionId}:${channelId}`;
    this.sessionPlaceholders.set(key, messageId);
    this.log.debug('Placeholder registered', { sessionId, channelId, messageId });
  }

  /**
   * Get and consume a placeholder for streaming
   *
   * Returns the placeholder message ID if one exists for this session+channel,
   * then removes it from tracking (one-time use).
   *
   * @param sessionId - ACP session ID
   * @param channelId - Channel to check
   * @returns Placeholder message ID, or undefined if none
   */
  private consumePlaceholder(sessionId: string, channelId: string): string | undefined {
    const key = `${sessionId}:${channelId}`;
    const messageId = this.sessionPlaceholders.get(key);
    if (messageId) {
      this.sessionPlaceholders.delete(key);
      this.log.debug('Placeholder consumed for streaming', { sessionId, channelId, messageId });
    }
    return messageId;
  }

  /**
   * Clear placeholder tracking for a session+channel on turn end
   *
   * Called when a turn completes to clean up any unconsumed placeholders.
   * This handles edge cases like empty responses where no text chunks arrive.
   *
   * AC: @discord-tool-widgets ac-21 - Memory cleanup for placeholder tracking
   *
   * @param sessionId - ACP session ID
   * @param channelId - Channel to clear
   */
  private clearPlaceholder(sessionId: string, channelId: string): void {
    const key = `${sessionId}:${channelId}`;
    if (this.sessionPlaceholders.has(key)) {
      this.sessionPlaceholders.delete(key);
      this.log.debug('Placeholder cleared (turn ended without consumption)', {
        sessionId,
        channelId,
      });
    }
  }

  /**
   * Create the AgentLifecycle instance from config
   */
  private createAgentLifecycle(): AgentLifecycle {
    // Parse command string into command + args
    const [command, ...args] = this.config.agentCommand.split(' ');
    return new AgentLifecycle({
      command,
      args,
      healthCheckInterval: this.config.healthCheckInterval,
      shutdownTimeout: this.config.shutdownTimeout,
    });
  }

  /**
   * Create the SessionKeyRouter instance
   */
  private createRouter(): SessionKeyRouter {
    const store = new InMemorySessionStore();
    const validAgents = new Set(['main']);
    return new SessionKeyRouter(store, validAgents);
  }

  /**
   * Set up event handlers for agent lifecycle
   *
   * AC-3: Escalation logged with context
   * AC-5: Health monitoring via AgentLifecycle (events forwarded)
   */
  private setupAgentEventHandlers(): void {
    // AC-3: Log escalation with context
    this.agent.on('escalate', (reason: string, context: Record<string, unknown>) => {
      this.handleEscalation(reason, context);
    });

    // AC-5 + @trait-health-monitored: Forward health events
    this.agent.on('health:status', (healthy: boolean, recovered: boolean) => {
      if (recovered) {
        this.log.info('Agent recovered from unhealthy state');
      } else if (!healthy) {
        this.log.warn('Agent marked unhealthy');
      }
      this.emit('agent:health', healthy, recovered);
    });

    // Forward state changes for observability
    this.agent.on('state:change', (from: string, to: string) => {
      this.log.info('Agent state changed', { from, to });
      this.emit('agent:state', from, to);
    });

    // Forward errors
    this.agent.on('error', (error: Error, ctx: Record<string, unknown>) => {
      this.log.error('Agent error', { error: error.message, ...ctx });
      this.emit('error', error, ctx);
    });

    // Log spawn events
    this.agent.on('agent:spawned', (pid: number) => {
      this.log.info('Agent process spawned', { pid });
    });

    // AC: @mem-session-lifecycle - Forward session lifecycle events
    this.sessionLifecycle.on(
      'session:created',
      (data: SessionLifecycleEvents['session:created']) => {
        this.log.info('Session created', { sessionKey: data.sessionKey });
        this.emit('session:created', data);
      }
    );

    this.sessionLifecycle.on(
      'session:rotated',
      (data: SessionLifecycleEvents['session:rotated']) => {
        this.log.info('Session rotated', { sessionKey: data.sessionKey });
        this.emit('session:rotated', data);
      }
    );

    this.sessionLifecycle.on(
      'session:recovered',
      (data: SessionLifecycleEvents['session:recovered']) => {
        this.log.info('Session recovered', { sessionKey: data.sessionKey });
        this.emit('session:recovered', data);
      }
    );

    this.contextUsageTracker.on('usage:error', (data: unknown) => {
      this.emit('usage:error', data);
    });
  }

  /**
   * Handle escalation from agent
   *
   * AC-3: Log escalation with context
   * AC-6: Uses escalationChannel or lastActiveChannel as fallback
   */
  private handleEscalation(reason: string, metadata: Record<string, unknown>): void {
    // AC-3: Log error with context
    this.log.error('Agent escalation', { reason, ...metadata });

    // AC-6: Emit event with fallback channel info
    const escalationContext: EscalationContext = {
      reason,
      metadata,
      targetChannel: this.config.escalationChannel ?? this.lastActiveChannel,
      timestamp: new Date(),
    };

    // @trait-observable: Emit escalation event
    this.emit('escalation', escalationContext);

    // Note: Actual channel notification is future work (EscalationHandler TODO)
    // MVP: just log. External handler can listen to 'escalation' event.
  }

  /**
   * Ensure the agent is ready for message processing
   *
   * @trait-recoverable: Handles agent spawn and waits for health
   */
  private async ensureAgentReady(timeoutMs = DEFAULT_AGENT_READY_TIMEOUT): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.agent.isHealthy()) {
        return;
      }

      const state = this.agent.getState();
      if (state === 'idle' || state === 'failed') {
        await this.agent.spawn();
        return;
      }

      if (state === 'stopping' || state === 'terminating') {
        throw new Error('Agent is shutting down');
      }

      // Wait and retry (spawning or unhealthy with recovery in progress)
      await new Promise((r) => setTimeout(r, INFLIGHT_POLL_INTERVAL));
    }

    throw new Error('Timeout waiting for agent to become ready');
  }

  /**
   * Wait for in-flight messages to complete
   *
   * @trait-graceful-shutdown: Drains messages with timeout
   */
  private async waitForInflightMessages(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (this.inflightCount > 0 && Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, INFLIGHT_POLL_INTERVAL));
    }

    if (this.inflightCount > 0) {
      this.log.warn('Shutdown timeout with inflight messages', {
        inflightCount: this.inflightCount,
      });
    }
  }

  /**
   * Transition to a new state
   */
  private transitionState(newState: BotState): void {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }

    this.log.debug('State transition', { from: oldState, to: newState });
    this.state = newState;
    // @trait-observable: Emit state:change event
    this.emit('state:change', oldState, newState);
  }

  /**
   * Wait for any active streaming response to complete
   *
   * AC: @bot-restart-api ac-8, ac-11
   */
  private async waitForStreamingCompletion(): Promise<void> {
    // If there are in-flight messages, wait for current turn to end
    if (this.inflightCount === 0) {
      return;
    }

    this.log.info('Waiting for streaming response to complete before restart', {
      inflightCount: this.inflightCount,
    });

    return new Promise<void>((resolve) => {
      const handler = () => {
        // Check if all in-flight messages are done
        if (this.inflightCount === 0) {
          this.off('turn:end', handler);
          resolve();
        }
      };

      // Subscribe to turn:end event
      this.on('turn:end', handler);

      // Also check immediately in case race condition
      if (this.inflightCount === 0) {
        this.off('turn:end', handler);
        resolve();
      }
    });
  }

  /**
   * Get session context for checkpoint
   *
   * AC: @bot-restart-api ac-10
   */
  private getSessionContextForCheckpoint(): {
    sessionId: string;
    sessionKey: string;
    inflightCount: number;
  } {
    // Get the first active session (or create a default context)
    const sessions = this.sessionLifecycle.getAllSessions();
    const activeSession = sessions[0];

    if (activeSession) {
      return {
        sessionId: activeSession.acpSessionId,
        sessionKey: activeSession.sessionKey,
        inflightCount: this.inflightCount,
      };
    }

    // Fallback: create minimal context
    return {
      sessionId: 'no-active-session',
      sessionKey: 'no-active-session',
      inflightCount: this.inflightCount,
    };
  }
}
