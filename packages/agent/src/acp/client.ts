/**
 * ACP (Agent Communication Protocol) Client
 *
 * Copied from: kynetic/packages/lifeline/src/acp/client.ts
 * Date copied: 2026-01-28
 * Modifications: Updated imports to use @kynetic-bot/core instead of @kynetic/shared
 *
 * Manages agent lifecycle and communication over JSON-RPC 2.0 stdio.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '@kynetic-bot/core';
import type { JsonRpcFramingOptions } from './framing.js';
import { JsonRpcFraming } from './framing.js';

const log = createLogger('acp');

import type {
  AgentCapabilities,
  ClientCapabilities,
  ContentBlock,
  CreateTerminalRequest,
  CreateTerminalResponse,
  InitializeRequest,
  InitializeResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from './types.js';
import { CLIENT_METHODS } from './types.js';

/**
 * Session state tracked by the client
 */
export interface SessionState {
  id: string;
  status: 'idle' | 'prompting' | 'cancelled';
}

/**
 * Source of a prompt - distinguishes user-initiated from system-derived prompts.
 * Used to filter which messages appear in user-facing chat UIs vs internal session logs.
 *
 * @see kynetic-g1ly - Add source metadata to distinguish user vs system prompts
 */
export type PromptSource = 'user' | 'system';

/**
 * Extended prompt request with internal metadata.
 * The `promptSource` field is NOT sent to the agent - it's used locally
 * to annotate emitted SessionUpdate events.
 */
export interface PromptRequestWithSource extends PromptRequest {
  /** Source of this prompt - 'user' for user-initiated, 'system' for internal/orchestration */
  promptSource?: PromptSource;
}

/**
 * Handlers for incoming requests from the agent
 */
export interface ACPClientHandlers {
  readFile?: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  writeFile?: (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
  createTerminal?: (params: CreateTerminalRequest) => Promise<CreateTerminalResponse>;
  getTerminalOutput?: (params: TerminalOutputRequest) => TerminalOutputResponse;
  waitForTerminalExit?: (
    params: WaitForTerminalExitRequest,
  ) => Promise<WaitForTerminalExitResponse>;
  killTerminal?: (params: KillTerminalCommandRequest) => Promise<KillTerminalCommandResponse>;
  releaseTerminal?: (params: ReleaseTerminalRequest) => ReleaseTerminalResponse;
  releaseSession?: (sessionId: string) => void;
  requestPermission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

/**
 * Options for ACPClient
 */
export interface ACPClientOptions extends JsonRpcFramingOptions {
  /** Client capabilities to advertise */
  capabilities?: ClientCapabilities;
  /** Client info */
  clientInfo?: {
    name: string;
    version?: string;
  };
  /** Handlers for incoming requests from agent */
  handlers?: ACPClientHandlers;
}

/**
 * ACP Client
 *
 * Manages agent communication over JSON-RPC 2.0 stdio transport.
 * Handles initialization, session lifecycle, prompts, and streaming updates.
 */
export class ACPClient extends EventEmitter {
  private framing: JsonRpcFraming;
  private sessions = new Map<string, SessionState>();
  private agentCapabilities: AgentCapabilities = {};
  private clientCapabilities: ClientCapabilities;
  private clientInfo?: { name: string; version?: string };
  private handlers: ACPClientHandlers;
  private initialized = false;

  constructor(options: ACPClientOptions = {}) {
    super();

    this.clientCapabilities = options.capabilities ?? {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    };

    this.clientInfo = options.clientInfo;
    this.handlers = options.handlers ?? {};

    // Create framing layer
    this.framing = new JsonRpcFraming(options);

    // Wire up request handler
    this.framing.on('request', (request: JsonRpcRequest) => {
      void this.handleRequest(request);
    });

    // Wire up notification handler
    this.framing.on('notification', (notification: JsonRpcNotification) => {
      this.handleNotification(notification);
    });

    // Forward framing events
    this.framing.on('close', () => this.emit('close'));
    this.framing.on('error', (err: Error) => this.emit('error', err));
  }

  /**
   * Initialize the agent connection
   */
  async initialize(): Promise<AgentCapabilities> {
    if (this.initialized) {
      throw new Error('Client already initialized');
    }

    const params: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: this.clientCapabilities,
      ...(this.clientInfo && {
        clientInfo: {
          name: this.clientInfo.name,
          version: this.clientInfo.version ?? '0.0.0',
        },
      }),
    };

    const result = (await this.framing.sendRequest('initialize', params)) as InitializeResponse;

    this.agentCapabilities = result.agentCapabilities ?? {};
    this.initialized = true;

    return this.agentCapabilities;
  }

  /**
   * Create a new session
   */
  async newSession(params: NewSessionRequest): Promise<string> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const result = (await this.framing.sendRequest('session/new', params)) as NewSessionResponse;

    // Track session state
    this.sessions.set(result.sessionId, {
      id: result.sessionId,
      status: 'idle',
    });

    return result.sessionId;
  }

  /**
   * Send a prompt to the agent
   *
   * @param params - Prompt request parameters. Optionally includes `promptSource`
   *   to distinguish user-initiated prompts from system/orchestration prompts.
   *   The `promptSource` is NOT sent to the agent - it's used to annotate
   *   emitted SessionUpdate events with `_meta.source`.
   *
   * @see kynetic-g1ly - Add source metadata to distinguish user vs system prompts
   */
  async prompt(params: PromptRequestWithSource): Promise<PromptResponse> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    if (session.status === 'prompting') {
      throw new Error(`Session already prompting: ${params.sessionId}`);
    }

    // Extract promptSource before sending to agent (kynetic-g1ly)
    // Default to 'system' for backward compatibility
    const source: PromptSource = params.promptSource ?? 'system';

    // Emit user_message_chunk events BEFORE sending to agent
    // This ensures prompts are captured in the session event log
    // Include source metadata to distinguish user vs system prompts
    // @see kynetic-44fa - Prompts sent to agents not stored in session events
    // @see kynetic-g1ly - Add source metadata to distinguish user vs system prompts
    for (const content of params.prompt) {
      const update: SessionUpdate = {
        sessionUpdate: 'user_message_chunk',
        content: content as ContentBlock,
        _meta: { source },
      };
      this.emit('update', params.sessionId, update);
    }

    // Update session state
    session.status = 'prompting';

    try {
      // Strip promptSource before sending to agent (it's for local use only)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { promptSource: _, ...agentParams } = params;
      const result = (await this.framing.sendRequest(
        'session/prompt',
        agentParams,
      )) as PromptResponse;

      // Update session state based on stop reason
      if (result.stopReason === 'cancelled') {
        session.status = 'cancelled';
      } else {
        session.status = 'idle';
      }

      return result;
    } catch (err) {
      // Reset to idle on error
      session.status = 'idle';
      throw err;
    }
  }

  /**
   * Cancel an ongoing prompt
   *
   * Note: session/cancel is an optional ACP method. If the agent doesn't
   * support it (returns "Method not found"), we silently ignore the error.
   * The caller should fall back to process termination (SIGTERM) if needed.
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      // Use silentMethodNotFound since not all agents implement session/cancel
      await this.framing.sendRequest(
        'session/cancel',
        { sessionId },
        { silentMethodNotFound: true },
      );

      // Update session state
      session.status = 'cancelled';
    } catch (err: unknown) {
      // Ignore "Method not found" errors - agent doesn't support cancel
      const error = err as { code?: number };
      if (error.code === -32601) {
        // Agent doesn't support session/cancel, caller should use SIGTERM
        return;
      }
      throw err;
    }
  }

  /**
   * Check if the agent supports session resumption
   */
  canResumeSession(): boolean {
    // This would be a capability like 'loadSession'
    // For now, return false as it's not in the current types
    return false;
  }

  /**
   * Get session state
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Close the client connection
   */
  close(): void {
    this.framing.close();
  }

  /**
   * Handle incoming requests from the agent
   */
  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    // Log all incoming requests for debugging
    const isTerminalMethod = request.method.startsWith('terminal/');
    const isFsMethod = request.method.startsWith('fs/');
    const isSessionMethod = request.method.startsWith('session/');
    if (isTerminalMethod || isFsMethod || isSessionMethod) {
      log.debug('Incoming request', { method: request.method, params: request.params });
    }

    try {
      let result: unknown;

      switch (request.method) {
        case CLIENT_METHODS.fs_read_text_file:
          if (!this.handlers.readFile) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = await this.handlers.readFile(request.params as ReadTextFileRequest);
          break;

        case CLIENT_METHODS.fs_write_text_file:
          if (!this.handlers.writeFile) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = await this.handlers.writeFile(request.params as WriteTextFileRequest);
          break;

        case CLIENT_METHODS.terminal_create:
          if (!this.handlers.createTerminal) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = await this.handlers.createTerminal(request.params as CreateTerminalRequest);
          break;

        case CLIENT_METHODS.terminal_output:
          if (!this.handlers.getTerminalOutput) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = this.handlers.getTerminalOutput(request.params as TerminalOutputRequest);
          break;

        case CLIENT_METHODS.terminal_wait_for_exit:
          if (!this.handlers.waitForTerminalExit) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = await this.handlers.waitForTerminalExit(
            request.params as WaitForTerminalExitRequest,
          );
          break;

        case CLIENT_METHODS.terminal_kill:
          if (!this.handlers.killTerminal) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = await this.handlers.killTerminal(request.params as KillTerminalCommandRequest);
          break;

        case CLIENT_METHODS.terminal_release:
          if (!this.handlers.releaseTerminal) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = this.handlers.releaseTerminal(request.params as ReleaseTerminalRequest);
          break;

        case CLIENT_METHODS.session_request_permission:
          if (!this.handlers.requestPermission) {
            throw { code: -32601, message: 'Method not supported' };
          }
          result = await this.handlers.requestPermission(
            request.params as RequestPermissionRequest,
          );
          break;

        default:
          throw { code: -32601, message: 'Method not found' };
      }

      // Log response for debugging
      if (isTerminalMethod || isFsMethod || isSessionMethod) {
        log.debug('Outgoing response', { method: request.method, result });
      }

      this.framing.sendResponse(request.id, result);
    } catch (err: unknown) {
      // Handle JSON-RPC error objects
      if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
        const error = err as { code: number; message: string };
        // Log error response for debugging (kynetic-3pm9)
        if (isTerminalMethod || isFsMethod || isSessionMethod) {
          log.error('Outgoing error response', { method: request.method, error });
        }
        this.framing.sendError(request.id, error);
      } else {
        // Convert generic errors to JSON-RPC errors
        const error = {
          code: -32603,
          message: 'Internal error',
          data: err instanceof Error ? err.message : String(err),
        };
        // Log error response for debugging
        if (isTerminalMethod || isFsMethod || isSessionMethod) {
          log.error('Outgoing error response', { method: request.method, error });
        }
        this.framing.sendError(request.id, error);
      }
    }
  }

  /**
   * Handle incoming notifications from the agent
   */
  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'session/update') {
      const sessionNotification = notification.params as SessionNotification;
      const update = sessionNotification.update as { sessionUpdate?: string; status?: string };

      // Log tool-related events for debugging (kynetic-3pm9)
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        log.debug('Session notification', {
          type: update.sessionUpdate,
          status: update.status || undefined,
        });
      }

      this.emit('update', sessionNotification.sessionId, sessionNotification.update);
    }
  }
}
