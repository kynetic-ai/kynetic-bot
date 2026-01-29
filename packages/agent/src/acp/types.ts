/**
 * ACP (Agent Communication Protocol) Type Definitions
 *
 * Copied from: kynetic/packages/lifeline/src/acp/types.ts
 * Date copied: 2026-01-28
 * Modifications: Updated imports to use @kynetic-bot/core instead of ../utils
 *
 * This module re-exports types from the official @agentclientprotocol/sdk
 * to ensure spec compliance. Types are imported at compile-time only
 * (zero runtime cost since TypeScript types are erased).
 *
 * We keep JSON-RPC 2.0 base types and type guards local since the SDK
 * doesn't export them in the same way we use them.
 */

import { hasProperty, isNumber, isObject, isString } from '@kynetic-bot/core';

// ============================================================================
// ACP Types from Official SDK
//
// Import everything from the SDK's generated types. These are guaranteed
// to match the official ACP specification.
// ============================================================================

export type {
  AgentCapabilities,
  AudioContent,
  AvailableCommand,
  AvailableCommandsUpdate,
  // Cancel types
  CancelNotification,
  ClientCapabilities,
  // Content types
  ContentBlock,
  // Content chunk (for streaming)
  ContentChunk,
  // Terminal types
  CreateTerminalRequest,
  CreateTerminalResponse,
  CurrentModeUpdate,
  EmbeddedResource,
  EnvVariable,
  // Error types
  ErrorCode,
  ImageContent,
  Implementation,
  // Initialize types
  InitializeRequest,
  InitializeResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  // MCP server configuration
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  // Session types
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PermissionOptionKind,
  // Plan types
  Plan,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  // Prompt types
  PromptRequest,
  PromptResponse,
  // Protocol version
  ProtocolVersion,
  // File system types
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  // Permission types
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResourceLink,
  SessionId,
  // Session mode types
  SessionMode,
  SessionModeId,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  TextContent,
  // Tool call types
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

// Import SDK CLIENT_METHODS type for validation
import type { CLIENT_METHODS as SDK_CLIENT_METHODS } from '@agentclientprotocol/sdk';

// ============================================================================
// ACP Method Names
//
// These constants define the official ACP method names as specified in the
// protocol. Defined locally to ensure inlining at build time (no runtime
// dependency on SDK for simple strings). Uses `satisfies` to validate against
// SDK types at compile time.
// ============================================================================

/**
 * ACP methods that the Client implements and the Agent can call.
 * Values must match the official ACP schema x-method fields.
 * Uses satisfies to ensure we stay in sync with the SDK.
 */
export const CLIENT_METHODS = {
  fs_read_text_file: 'fs/read_text_file',
  fs_write_text_file: 'fs/write_text_file',
  session_request_permission: 'session/request_permission',
  session_update: 'session/update',
  terminal_create: 'terminal/create',
  terminal_kill: 'terminal/kill',
  terminal_output: 'terminal/output',
  terminal_release: 'terminal/release',
  terminal_wait_for_exit: 'terminal/wait_for_exit',
} as const satisfies typeof SDK_CLIENT_METHODS;

/**
 * Type for CLIENT_METHODS values
 */
export type ClientMethod = (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];

// ============================================================================
// Type Aliases for Backward Compatibility
//
// These aliases map our old type names to the SDK's official names.
// This allows gradual migration without breaking existing code.
// ============================================================================

import type {
  CreateTerminalRequest as _CreateTerminalRequest,
  CreateTerminalResponse as _CreateTerminalResponse,
  InitializeRequest as _InitializeRequest,
  InitializeResponse as _InitializeResponse,
  NewSessionRequest as _NewSessionRequest,
  NewSessionResponse as _NewSessionResponse,
  PromptRequest as _PromptRequest,
  PromptResponse as _PromptResponse,
  ReadTextFileRequest as _ReadTextFileRequest,
  ReadTextFileResponse as _ReadTextFileResponse,
  WriteTextFileRequest as _WriteTextFileRequest,
  WriteTextFileResponse as _WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/** @deprecated Use InitializeRequest */
export type InitializeParams = _InitializeRequest;
/** @deprecated Use InitializeResponse */
export type InitializeResult = _InitializeResponse;
/** @deprecated Use NewSessionRequest */
export type NewSessionParams = _NewSessionRequest;
/** @deprecated Use NewSessionResponse */
export type NewSessionResult = _NewSessionResponse;
/** @deprecated Use PromptRequest */
export type PromptParams = _PromptRequest;
/** @deprecated Use PromptResponse */
export type PromptResult = _PromptResponse;
/** @deprecated Use ReadTextFileRequest */
export type FsReadTextFileParams = _ReadTextFileRequest;
/** @deprecated Use ReadTextFileResponse */
export type FsReadTextFileResult = _ReadTextFileResponse;
/** @deprecated Use WriteTextFileRequest */
export type FsWriteTextFileParams = _WriteTextFileRequest;
/** @deprecated Use WriteTextFileResponse */
export type FsWriteTextFileResult = _WriteTextFileResponse;
/** @deprecated Use CreateTerminalRequest */
export type TerminalCreateParams = _CreateTerminalRequest;
/** @deprecated Use CreateTerminalResponse */
export type TerminalCreateResult = _CreateTerminalResponse;

// ============================================================================
// JSON-RPC 2.0 Base Types
//
// These are kept local because:
// 1. The SDK's internal JSON-RPC types aren't exported the same way
// 2. We need specific shapes for our type guards
// 3. These are standard JSON-RPC types, not ACP-specific
// ============================================================================

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 Response (success)
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Error that can be thrown
 * Extends Error so it satisfies @typescript-eslint/only-throw-error
 */
export class JsonRpcException extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcException';
    this.code = code;
    this.data = data;
  }

  /**
   * Convert to a JSON-RPC error object
   */
  toErrorObject(): JsonRpcErrorObject {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined && { data: this.data }),
    };
  }
}

/**
 * JSON-RPC 2.0 Error response
 */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

/**
 * JSON-RPC 2.0 Notification (no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Any JSON-RPC message type
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcError | JsonRpcNotification;

// ============================================================================
// JSON-RPC Type Guards
//
// Runtime type guards for validating incoming messages.
// These work with unknown data and narrow to specific types.
// ============================================================================

/**
 * Type guard for JSON-RPC Request
 */
export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    'id' in msg &&
    (isString(msg.id) || isNumber(msg.id)) &&
    hasProperty(msg, 'method') &&
    isString(msg.method)
  );
}

/**
 * Type guard for JSON-RPC Response
 */
export function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    'id' in msg &&
    (isString(msg.id) || isNumber(msg.id)) &&
    'result' in msg &&
    !('error' in msg)
  );
}

/**
 * Type guard for JSON-RPC Error
 */
export function isError(msg: unknown): msg is JsonRpcError {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    'id' in msg &&
    (msg.id === null || isString(msg.id) || isNumber(msg.id)) &&
    hasProperty(msg, 'error') &&
    isObject(msg.error) &&
    hasProperty(msg.error, 'code') &&
    isNumber(msg.error.code) &&
    hasProperty(msg.error, 'message') &&
    isString(msg.error.message)
  );
}

/**
 * Type guard for JSON-RPC Notification
 */
export function isNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    !('id' in msg) &&
    hasProperty(msg, 'method') &&
    isString(msg.method)
  );
}

// ============================================================================
// Context Usage Types
//
// Types for capturing /context output from agent stderr.
// These are not part of ACP spec but are used internally for monitoring.
// ============================================================================

/**
 * A category of context usage (e.g., "System prompt", "Messages")
 */
export interface ContextCategory {
  name: string;
  tokens: number;
  percentage: number;
}

/**
 * MCP tool usage within context
 */
export interface ContextMcpTool {
  name: string;
  server: string;
  tokens: number;
}

/**
 * Custom agent usage within context
 */
export interface ContextCustomAgent {
  type: string;
  source: string;
  tokens: number;
}

/**
 * Memory file usage within context
 */
export interface ContextMemoryFile {
  type: string;
  path: string;
  tokens: number;
}

/**
 * Slash commands usage within context
 */
export interface ContextSlashCommands {
  shown: number;
  total: number;
  tokens: number;
}

/**
 * Context usage update parsed from agent stderr /context output
 */
export interface ContextUsageUpdate {
  type: 'context_usage';
  model: string;
  tokens: {
    current: number;
    max: number;
    percentage: number;
  };
  categories: ContextCategory[];
  mcpTools?: ContextMcpTool[];
  customAgents?: ContextCustomAgent[];
  memoryFiles?: ContextMemoryFile[];
  slashCommands?: ContextSlashCommands;
  timestamp: number;
}
