/**
 * ACP (Agent Communication Protocol) Module
 *
 * This module provides client-side ACP implementation for communicating
 * with agents over JSON-RPC 2.0 stdio transport.
 */

export { ACPClient } from './client.js';
export type {
  ACPClientHandlers,
  ACPClientOptions,
  PromptRequestWithSource,
  PromptSource,
  SessionState,
} from './client.js';

export { JsonRpcFraming } from './framing.js';
export type { JsonRpcFramingOptions, SendRequestOptions } from './framing.js';

export { CLIENT_METHODS } from './types.js';
export type { ClientMethod } from './types.js';

// Re-export all ACP types from SDK
export type {
  AgentCapabilities,
  AudioContent,
  AvailableCommand,
  AvailableCommandsUpdate,
  CancelNotification,
  ClientCapabilities,
  ContentBlock,
  ContentChunk,
  ContextCategory,
  ContextCustomAgent,
  ContextMcpTool,
  ContextMemoryFile,
  ContextSlashCommands,
  ContextUsageUpdate,
  CreateTerminalRequest,
  CreateTerminalResponse,
  CurrentModeUpdate,
  EmbeddedResource,
  EnvVariable,
  ErrorCode,
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  FsWriteTextFileResult,
  ImageContent,
  Implementation,
  InitializeParams,
  InitializeRequest,
  InitializeResponse,
  InitializeResult,
  JsonRpcError,
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  NewSessionParams,
  NewSessionRequest,
  NewSessionResponse,
  NewSessionResult,
  PermissionOption,
  PermissionOptionKind,
  Plan,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  PromptParams,
  PromptRequest,
  PromptResponse,
  PromptResult,
  ProtocolVersion,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResourceLink,
  SessionId,
  SessionMode,
  SessionModeId,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  TextContent,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from './types.js';

// Re-export type guards
export {
  isError,
  isNotification,
  isRequest,
  isResponse,
} from './types.js';
