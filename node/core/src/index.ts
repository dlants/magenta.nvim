export { runScript, type EdlRegisters } from "./edl/index.ts";
export type { FileMutationSummary } from "./edl/types.ts";
export { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
export type { FileIO } from "./capabilities/file-io.ts";
export { FsFileIO } from "./capabilities/file-io.ts";
export {
  Executor,
  resolveIndex,
  type InitialDocIndex,
} from "./edl/executor.ts";
export { parse } from "./edl/parser.ts";
export type { Logger } from "./logger.ts";
export type { AbsFilePath, Cwd } from "./paths.ts";
export {
  type RelFilePath,
  type UnresolvedFilePath,
  type HomeDir,
  type DisplayPath,
  type NvimCwd,
  FileCategory,
  type FileTypeInfo,
  MAGENTA_TEMP_DIR,
  resolveFilePath,
  relativePath,
  displayPath,
  expandTilde,
  detectFileType,
  isLikelyTextFile,
  categorizeFileType,
  validateFileSize,
  FILE_SIZE_LIMITS,
} from "./utils/files.ts";
export type { AuthUI } from "./auth-ui.ts";
export { assertUnreachable } from "./utils/assertUnreachable.ts";
export type {
  Success,
  ResultError,
  Result,
  ExtractSuccess,
} from "./utils/result.ts";
export { extendError } from "./utils/result.ts";
export { delay, Defer, pollUntil, withTimeout } from "./utils/async.ts";
export type { Dispatch } from "./dispatch.ts";
export type {
  ToolRequestId,
  ToolName,
  ToolRequest,
  ValidateInput,
  DisplayContext,
  CompletedToolInfo,
  GenericToolRequest,
  ToolInvocation,
  ToolManagerToolMsg,
  ToolMsg,
} from "./tool-types.ts";
export type { Role, ThreadId, MessageIdx, ThreadType } from "./chat-types.ts";
export type {
  ProviderName,
  ProviderProfile,
  ProviderOptions,
} from "./provider-options.ts";
export type { OAuthTokens, AnthropicAuth } from "./anthropic-auth.ts";
export { getProvider, setMockProvider } from "./providers/provider.ts";
export { PROVIDER_NAMES } from "./providers/provider-types.ts";
export type {
  Provider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderTextContent,
  ProviderThinkingContent,
  ProviderRedactedThinkingContent,
  ProviderToolUseContent,
  ProviderServerToolUseContent,
  ProviderWebSearchToolResult,
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderImageContent,
  ProviderDocumentContent,
  ProviderToolSpec,
  ProviderStreamRequest,
  ProviderToolUseRequest,
  ProviderStreamEvent,
  ProviderBlockStartEvent,
  ProviderBlockDeltaEvent,
  ProviderBlockStopEvent,
  ProviderSetting,
  ProviderSystemReminderContent,
  ProviderContextUpdateContent,
  ProviderWebSearchCitation,
  StopReason,
  Usage,
  Agent,
  AgentOptions,
  AgentInput,
  AgentMsg,
  AgentState,
  AgentStatus,
  AgentStreamingBlock,
  NativeMessageIdx,
  ProviderMetadata,
  ProviderToolUseResponse,
} from "./providers/provider-types.ts";
export { createSystemPrompt } from "./providers/system-prompt.ts";
export type {
  SystemPrompt,
  SystemInfo,
  AgentType,
} from "./providers/system-prompt.ts";
export {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  EXPLORE_SUBAGENT_SYSTEM_PROMPT,
  COMPACT_SYSTEM_PROMPT,
  AGENT_TYPES,
} from "./providers/system-prompt.ts";
export { loadSkills, formatSkillsIntroduction } from "./providers/skills.ts";
export type { SkillInfo, SkillsMap } from "./providers/skills.ts";
export { getSubsequentReminder } from "./providers/system-reminders.ts";
export {
  AnthropicAgent,
  convertAnthropicMessagesToProvider,
  CLAUDE_CODE_SPOOF_PROMPT,
  getMaxTokensForModel,
  getContextWindowForModel,
  withCacheControl,
} from "./providers/anthropic-agent.ts";
export type { AnthropicAgentOptions } from "./providers/anthropic-agent.ts";
export { AnthropicProvider } from "./providers/anthropic.ts";
export { BedrockProvider } from "./providers/bedrock.ts";
export type { BedrockProviderOptions } from "./providers/bedrock.ts";
export {
  STATIC_TOOL_NAMES,
  type StaticToolName,
  CHAT_STATIC_TOOL_NAMES,
  COMPACT_STATIC_TOOL_NAMES,
  SUBAGENT_STATIC_TOOL_NAMES,
  TOOL_CAPABILITIES,
  type ToolCapability,
  TOOL_REQUIRED_CAPABILITIES,
} from "./tools/tool-registry.ts";
export {
  type MCPToolName,
  type MCPToolRequestParams,
  type ServerName,
  validateServerName,
  mcpToolNameToToolName,
  parseToolName,
} from "./tools/mcp/types.ts";
export {
  calculateStringPosition,
  type StringIdx,
  type Row0Indexed,
  type PositionString,
} from "./utils/string-position.ts";
export {
  extractPDFPage,
  getPDFPageCount,
  getSummaryAsProviderContent,
} from "./utils/pdf-pages.ts";
export {
  type Chunk,
  type FileSummary,
  tokenize,
  buildFrequencyTable,
  chunkFile,
  computeScopeSize,
  scoreChunk,
  selectChunks,
  summarizeFile,
  formatSummary,
} from "./utils/file-summary.ts";
export type {
  LspClient,
  LspRange,
  LspHoverResponse,
  LspReferencesResponse,
  LspDefinitionResponse,
} from "./capabilities/lsp-client.ts";
export type { DiagnosticsProvider } from "./capabilities/diagnostics-provider.ts";
export type {
  ContextTracker,
  TrackedFileInfo,
  ToolApplied,
  OnToolApplied,
} from "./capabilities/context-tracker.ts";
export type { Shell, ShellResult, OutputLine } from "./capabilities/shell.ts";
export type { ThreadManager } from "./capabilities/thread-manager.ts";
export type {
  MCPServerConfig,
  MCPServersConfig,
  MCPMockToolConfig,
  MCPMockToolSchemaType,
} from "./tools/mcp/options.ts";
export {
  extractPartialJsonStringValue,
  validateInput,
} from "./tools/helpers.ts";
export {
  getToolSpecs,
  type MCPToolManager,
  type StaticToolMap,
  type StaticToolRequest,
  type Msg as ToolManagerMsg,
} from "./tools/toolManager.ts";
export { MCPClient } from "./tools/mcp/client.ts";
export {
  MCPToolManager as MCPToolManagerImpl,
  isMCPTool,
} from "./tools/mcp/manager.ts";
export {
  MockMCPServer,
  MockToolStub,
  mockServers,
} from "./tools/mcp/mock-server.ts";
export {
  type MCPProgress,
  execute as executeMCPTool,
} from "./tools/mcp/tool.ts";

export * as GetFile from "./tools/getFile.ts";
export * as Hover from "./tools/hover.ts";
export * as FindReferences from "./tools/findReferences.ts";
export * as Diagnostics from "./tools/diagnostics.ts";
export * as BashCommand from "./tools/bashCommand.ts";
export * as ThreadTitle from "./tools/thread-title.ts";
export * as SpawnSubagent from "./tools/spawn-subagent.ts";
export * as SpawnForeach from "./tools/spawn-foreach.ts";
export * as WaitForSubagents from "./tools/wait-for-subagents.ts";
export * as YieldToParent from "./tools/yield-to-parent.ts";
export * as Edl from "./tools/edl.ts";
export { createTool, type CreateToolContext } from "./tools/create-tool.ts";

export type { ContainerConfig, ProvisionResult } from "./container/types.ts";
export { provisionContainer } from "./container/provision.ts";
export { teardownContainer } from "./container/teardown.ts";
