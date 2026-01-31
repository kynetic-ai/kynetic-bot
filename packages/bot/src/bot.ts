/**
 * Bot Orchestration
 *
 * Main Bot class that wires together ChannelRegistry, AgentLifecycle,
 * SessionKeyRouter, and KbotShadow. Handles message flow from Discord
 * through agent processing to response delivery.
 *
 * @see @bot-orchestration
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createLogger, type NormalizedMessage } from '@kynetic-bot/core';
import { ChannelRegistry, ChannelLifecycle } from '@kynetic-bot/channels';
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
} from '@kynetic-bot/messaging';
import {
  KbotShadow,
  ConversationStore,
  SessionStore as MemorySessionStore,
  type ConversationMetadata,
} from '@kynetic-bot/memory';
import type { BotConfig } from './config.js';
import { buildIdentityPrompt } from './identity.js';

const DEFAULT_AGENT_READY_TIMEOUT = 30000;
const INFLIGHT_POLL_INTERVAL = 100;

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
export class Bot extends EventEmitter {
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
  private readonly log = createLogger('bot');

  /**
   * Private constructor - use Bot.create() factory
   */
  private constructor(options: BotOptions) {
    super();
    this.config = options.config;
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

    this.contextRestorer =
      options.contextRestorer ??
      new ContextRestorer(options.summaryProvider ?? null, { logger: this.log });

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
   *
   * @param config - Bot configuration
   * @returns Initialized Bot instance
   */
  static async create(config: BotConfig): Promise<Bot> {
    const bot = new Bot({ config });

    // Initialize KbotShadow (creates .kbot/ if needed)
    await bot.shadow.initialize();

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
      await this.channelLifecycle.sendTyping(msg.channel);
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

      // AC: @bot-storage-integration ac-2 - Get or create conversation, append user turn
      try {
        conversation = await this.conversationStore.getOrCreateConversation(sessionKey);
        await this.conversationStore.appendTurn(conversation.id, {
          role: 'user',
          content: msg.text,
          message_id: msg.id,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error('Failed to persist user turn', { error: error.message, messageId: msg.id });
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

      // AC: @bot-identity ac-1, ac-2 - Send identity prompt for new sessions WITHOUT prior history
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
      let cumulativeText = ''; // Track cumulative text for edit-based streaming
      let coalescer: StreamCoalescer | BufferedCoalescer;

      if (isStreamingPlatform && this.channelLifecycle) {
        // AC-2: Streaming platform - use StreamCoalescer for incremental delivery
        coalescer = new StreamCoalescer({
          minChars: 1500,
          idleMs: 1000,
          onChunk: async (chunk) => {
            if (!this.channelLifecycle) return;
            // Accumulate text for edit-based streaming (Discord edits full message)
            cumulativeText += chunk;
            if (!streamingMessageId) {
              // First chunk - send initial message and capture ID for edits
              const result = await this.channelLifecycle.sendMessage(msg.channel, cumulativeText, {
                replyTo: msg.id,
              });
              streamingMessageId = result?.messageId;
            } else {
              // Subsequent chunks - edit existing message with accumulated text
              await this.channelLifecycle.editMessage?.(
                msg.channel,
                streamingMessageId,
                cumulativeText
              );
            }
          },
          onComplete: async (fullText) => {
            responseText = fullText;
            // Final edit to ensure complete message is displayed
            if (this.channelLifecycle && streamingMessageId && fullText) {
              await this.channelLifecycle.editMessage?.(msg.channel, streamingMessageId, fullText);
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
          }
        }, this.log);
      }

      // 6. Set up update handler to feed chunks through coalescer
      const updateHandler = (_sid: string, update: SessionUpdate) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          const text = update.content.text ?? '';
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
        if (update.sessionUpdate === 'tool_call') {
          this.emit(
            'tool:call',
            sessionId,
            msg.channel,
            update as ToolCall & { sessionUpdate: string }
          );
        }

        // When sessionUpdate is 'tool_call_update', the update object IS the ToolCallUpdate
        if (update.sessionUpdate === 'tool_call_update') {
          this.emit(
            'tool:update',
            sessionId,
            msg.channel,
            update as ToolCallUpdate & { sessionUpdate: string }
          );
        }
      };
      client.on('update', updateHandler);

      try {
        // 7. Send prompt to agent and wait for completion
        await client.prompt({
          sessionId,
          prompt: [{ type: 'text', text: msg.text }],
          promptSource: 'user',
        });

        // 8. Complete the coalescer to flush any remaining buffered content
        await coalescer.complete();
      } catch (err) {
        // AC-4: Abort coalescer on error/disconnect
        if (coalescer instanceof StreamCoalescer) {
          coalescer.abort();
        }
        throw err;
      } finally {
        client.off('update', updateHandler);
      }

      // AC: @bot-storage-integration ac-4 - Append assistant turn
      if (responseText && conversation) {
        try {
          await this.conversationStore.appendTurn(conversation.id, {
            role: 'assistant',
            content: responseText,
            agent_session_id: sessionId,
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

      // @trait-observable: Emit message:processed event
      this.emit('message:processed', msg, Date.now() - startTime);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Message handling failed', { error: error.message, messageId: msg.id });
      // @trait-observable: Emit message:error event
      this.emit('message:error', msg, error);
    } finally {
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
}
