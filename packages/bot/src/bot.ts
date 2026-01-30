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
import { createLogger, type NormalizedMessage } from '@kynetic-bot/core';
import { ChannelRegistry, ChannelLifecycle } from '@kynetic-bot/channels';
import { AgentLifecycle } from '@kynetic-bot/agent';
import { SessionKeyRouter, type SessionStore, type Session } from '@kynetic-bot/messaging';
import { KbotShadow } from '@kynetic-bot/memory';
import type { BotConfig } from './config.js';

const DEFAULT_AGENT_READY_TIMEOUT = 30000;
const INFLIGHT_POLL_INTERVAL = 100;

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
}

/**
 * In-memory session store implementation
 */
class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  create(
    key: string,
    agent: string,
    platform: string,
    peerId: string,
    peerKind: 'user' | 'channel',
  ): Session {
    const session: Session = {
      key,
      agent,
      platform,
      peerId,
      peerKind,
      context: [],
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(key, session);
    return session;
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }
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
  private channelLifecycle: ChannelLifecycle | null = null;

  private lastActiveChannel: string | null = null;
  private inflightCount = 0;
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
    this.shadow = options.shadow ?? new KbotShadow({ projectRoot: this.config.kbotDataDir });

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

      // 3. Stop agent gracefully
      await this.agent.stop();

      // 4. Shutdown shadow (final commit)
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

    try {
      // 1. Route to session
      const sessionResult = this.router.resolveSession(msg, 'main');
      if (!sessionResult.ok) {
        this.log.error('Routing failed', { error: sessionResult.error.message });
        this.emit('error', sessionResult.error, { messageId: msg.id });
        return;
      }

      // 2. Ensure agent is healthy
      await this.ensureAgentReady();

      // 3. Get ACP client
      const client = this.agent.getClient();
      if (!client) {
        throw new Error('Agent client not available after ready check');
      }

      // 4. Create session if needed, then prompt
      let sessionId = this.agent.getSessionId();
      if (!sessionId) {
        sessionId = await client.newSession({});
      }

      // 5. Send prompt to agent
      const response = await client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: msg.text }],
        promptSource: 'user',
      });

      // 6. Extract and send response via channel
      const responseText = this.extractResponseText(response);
      if (responseText && this.channelLifecycle) {
        await this.channelLifecycle.sendMessage(msg.channel, responseText, {
          replyTo: msg.id,
        });
      }

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
   * Extract text from prompt response
   */
  private extractResponseText(response: { result?: unknown[] }): string | null {
    if (!response.result || !Array.isArray(response.result)) {
      return null;
    }

    const textParts: string[] = [];
    for (const item of response.result) {
      if (typeof item === 'object' && item !== null && 'text' in item) {
        textParts.push(String((item as { text: unknown }).text));
      }
    }

    return textParts.length > 0 ? textParts.join('') : null;
  }
}
