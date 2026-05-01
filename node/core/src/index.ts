export type { AgentInfo, AgentsMap } from "./agents/agents.ts";
export { loadAgents } from "./agents/agents.ts";
export type { AnthropicAuth, OAuthTokens } from "./anthropic-auth.ts";
export type { AuthUI } from "./auth-ui.ts";
export type {
  ContextTracker,
  OnToolApplied,
  ToolApplied,
  TrackedFileInfo,
} from "./capabilities/context-tracker.ts";
export type { DiagnosticsProvider } from "./capabilities/diagnostics-provider.ts";
export type { FileIO } from "./capabilities/file-io.ts";
export { FsFileIO } from "./capabilities/file-io.ts";
export type { HelpTagsProvider } from "./capabilities/help-tags-provider.ts";
export type {
  LspClient,
  LspDefinitionResponse,
  LspHoverResponse,
  LspRange,
  LspReferencesResponse,
} from "./capabilities/lsp-client.ts";
export type { OutputLine, Shell, ShellResult } from "./capabilities/shell.ts";
export type {
  DockerSpawnConfig,
  ThreadManager,
} from "./capabilities/thread-manager.ts";
export type {
  MessageIdx,
  Role,
  SubagentConfig,
  ThreadId,
  ThreadType,
} from "./chat-types.ts";
export {
  CHARS_PER_TOKEN,
  chunkMessages,
  type RenderResult,
  renderThreadToMarkdown,
  TARGET_CHUNK_TOKENS,
  TOLERANCE_TOKENS,
} from "./compact-renderer.ts";
export type {
  CompactionController,
  CompactionRecord,
  CompactionResult,
  CompactionStep,
} from "./compaction-controller.ts";
export {
  type CompactionAction,
  type CompactionEvents,
  CompactionManager,
  type CompactionManagerContext,
  type CompactionState,
} from "./compaction-manager.ts";
export { provisionContainer } from "./container/provision.ts";
export { teardownContainer } from "./container/teardown.ts";
export type {
  ContainerConfig,
  ProvisionResult,
  TeardownResult,
} from "./container/types.ts";
export {
  ContextManager,
  type ContextManagerEvents,
  type DiffUpdate,
  type FileDeletedUpdate,
  type Files as ContextFiles,
  type FileUpdate,
  type FileUpdates,
  type Patch,
  type WholeFileUpdate,
} from "./context/context-manager.ts";
export type { Dispatch } from "./dispatch.ts";
export {
  Executor,
  type InitialDocIndex,
  resolveIndex,
} from "./edl/executor.ts";
export { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
export { type EdlRegisters, runScript } from "./edl/index.ts";
export { parse } from "./edl/parser.ts";
export type { FileMutationSummary } from "./edl/types.ts";
export { Emitter, type EventMap } from "./emitter.ts";
export type { Logger } from "./logger.ts";
export type { AbsFilePath, Cwd } from "./paths.ts";
export type {
  ProviderName,
  ProviderOptions,
  ProviderProfile,
} from "./provider-options.ts";
export { AnthropicProvider } from "./providers/anthropic.ts";
export type { AnthropicAgentOptions } from "./providers/anthropic-agent.ts";
export {
  AnthropicAgent,
  CLAUDE_CODE_SPOOF_PROMPT,
  convertAnthropicMessagesToProvider,
  getContextWindowForModel,
  getMaxTokensForModel,
  withCacheControl,
} from "./providers/anthropic-agent.ts";
export type { BedrockProviderOptions } from "./providers/bedrock.ts";
export { BedrockProvider } from "./providers/bedrock.ts";
export {
  MockAnthropicClient,
  MockStream,
} from "./providers/mock-anthropic-client.ts";
export { getProvider, setMockProvider } from "./providers/provider.ts";
export type {
  Agent,
  AgentInput,
  AgentMsg,
  AgentOptions,
  AgentState,
  AgentStatus,
  AgentStreamingBlock,
  NativeMessageIdx,
  Provider,
  ProviderBlockDeltaEvent,
  ProviderBlockStartEvent,
  ProviderBlockStopEvent,
  ProviderContextUpdateContent,
  ProviderDocumentContent,
  ProviderImageContent,
  ProviderMessage,
  ProviderMessageContent,
  ProviderMetadata,
  ProviderRedactedThinkingContent,
  ProviderServerToolUseContent,
  ProviderSetting,
  ProviderStreamEvent,
  ProviderStreamRequest,
  ProviderSystemReminderContent,
  ProviderTextContent,
  ProviderThinkingContent,
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
  ProviderToolUseContent,
  ProviderToolUseRequest,
  ProviderToolUseResponse,
  ProviderWebSearchCitation,
  ProviderWebSearchToolResult,
  RetryStatus,
  StopReason,
  Usage,
} from "./providers/provider-types.ts";
export {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  PROVIDER_NAMES,
} from "./providers/provider-types.ts";
export type { SkillInfo, SkillsMap } from "./providers/skills.ts";
export { formatSkillsIntroduction, loadSkills } from "./providers/skills.ts";
export type {
  SystemInfo,
  SystemPrompt,
} from "./providers/system-prompt.ts";
export {
  COMPACT_SYSTEM_PROMPT,
  createSystemPrompt,
} from "./providers/system-prompt.ts";
export {
  buildSystemReminder,
  type ReminderKind,
} from "./providers/system-reminders.ts";
export {
  type ActiveToolEntry,
  type EnvironmentConfig,
  type InputMessage,
  ThreadCore,
  type ThreadCoreAction,
  type ThreadCoreContext,
  type ThreadCoreEvents,
  type ThreadMode,
  type ToolCache,
} from "./thread-core.ts";
export type {
  EndTurnContext,
  SupervisorAction,
  ThreadSupervisor,
} from "./thread-supervisor.ts";
export {
  SubagentSupervisor,
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";
export type {
  CompletedToolInfo,
  DisplayContext,
  GenericStructuredResult,
  GenericToolRequest,
  ToolInvocation,
  ToolManagerToolMsg,
  ToolMsg,
  ToolName,
  ToolRequest,
  ToolRequestId,
  ToolStructuredResult,
  ValidateInput,
} from "./tool-types.ts";
export * as BashCommand from "./tools/bashCommand.ts";
export { type CreateToolContext, createTool } from "./tools/create-tool.ts";
export * as Diagnostics from "./tools/diagnostics.ts";
export * as Docs from "./tools/docs.ts";
export * as Edl from "./tools/edl.ts";
export * as FindReferences from "./tools/findReferences.ts";
export * as GetFile from "./tools/getFile.ts";
export {
  extractPartialJsonStringValue,
  validateInput,
} from "./tools/helpers.ts";
export * as Hover from "./tools/hover.ts";
export { MCPClient } from "./tools/mcp/client.ts";
export {
  isMCPTool,
  MCPToolManager as MCPToolManagerImpl,
} from "./tools/mcp/manager.ts";
export {
  MockMCPServer,
  MockToolStub,
  mockServers,
} from "./tools/mcp/mock-server.ts";
export type {
  MCPMockToolConfig,
  MCPMockToolSchemaType,
  MCPServerConfig,
  MCPServersConfig,
} from "./tools/mcp/options.ts";
export {
  execute as executeMCPTool,
  type MCPProgress,
} from "./tools/mcp/tool.ts";
export {
  type MCPToolName,
  type MCPToolRequestParams,
  mcpToolNameToToolName,
  parseToolName,
  type ServerName,
  validateServerName,
} from "./tools/mcp/types.ts";
export * as SpawnSubagents from "./tools/spawn-subagents.ts";
export * as ThreadTitle from "./tools/thread-title.ts";
export {
  CHAT_STATIC_TOOL_NAMES,
  COMPACT_STATIC_TOOL_NAMES,
  STATIC_TOOL_NAMES,
  type StaticToolName,
  SUBAGENT_STATIC_TOOL_NAMES,
  TOOL_CAPABILITIES,
  TOOL_REQUIRED_CAPABILITIES,
  type ToolCapability,
} from "./tools/tool-registry.ts";
export {
  getToolSpecs,
  type MCPToolManager,
  type Msg as ToolManagerMsg,
  type StaticToolMap,
  type StaticToolRequest,
} from "./tools/toolManager.ts";

export * as YieldToParent from "./tools/yield-to-parent.ts";
export { assertUnreachable } from "./utils/assertUnreachable.ts";
export { Defer, delay, pollUntil, withTimeout } from "./utils/async.ts";
export type {
  ClipboardImageLogger,
  ClipboardProbeResult,
} from "./utils/clipboard-image.ts";
export { probeAndSaveClipboardImage } from "./utils/clipboard-image.ts";
export {
  buildFrequencyTable,
  type Chunk,
  chunkFile,
  computeScopeSize,
  type FileSummary,
  formatSummary,
  scoreChunk,
  selectChunks,
  summarizeFile,
  tokenize,
} from "./utils/file-summary.ts";
export {
  AT_FILE_PATTERN,
  categorizeFileType,
  type DisplayPath,
  detectFileType,
  detectFileTypeViaFileIO,
  displayPath,
  expandTilde,
  extractFileRefPath,
  FILE_SIZE_LIMITS,
  FileCategory,
  type FileTypeInfo,
  formatFileRef,
  type HomeDir,
  isLikelyTextFile,
  MAGENTA_TEMP_DIR,
  type NvimCwd,
  type RelFilePath,
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
  unescapeFenceBody,
  validateFileSize,
} from "./utils/files.ts";
export {
  extractPDFPage,
  getPDFPageCount,
  getSummaryAsProviderContent,
} from "./utils/pdf-pages.ts";
export type {
  ExtractSuccess,
  Result,
  ResultError,
  Success,
} from "./utils/result.ts";
export { extendError } from "./utils/result.ts";
export {
  calculateStringPosition,
  type PositionString,
  type Row0Indexed,
  type StringIdx,
} from "./utils/string-position.ts";
