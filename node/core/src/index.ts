export {
  type ActiveToolEntry,
  Agent,
  type AgentAction,
  type AgentContext,
  type AgentEvents,
  type EnvironmentConfig,
  type InputMessage,
  type ThreadMode,
} from "./agent.ts";
export type { AgentInfo, AgentsMap } from "./agents/agents.ts";
export { loadAgents } from "./agents/agents.ts";
export type { AnthropicAuth, OAuthTokens } from "./anthropic-auth.ts";
export type { ArchiveEntry, ThreadMeta } from "./archive.ts";
export {
  deleteArchivedThread,
  listArchivedThreadIds,
  listArchivedThreads,
  readArchivedThreadLog,
  readThreadMeta,
  threadCreatedAt,
} from "./archive.ts";
export { renderThreadLogToMarkdown } from "./archive-renderer.ts";
export type { AuthUI } from "./auth-ui.ts";
export type {
  ContextTracker,
  OnToolApplied,
  ToolApplied,
  TrackedFileInfo,
} from "./capabilities/context-tracker.ts";
export type { FileIO } from "./capabilities/file-io.ts";
export { FsFileIO } from "./capabilities/file-io.ts";
export {
  formatGitHead,
  formatGitInfo,
  type GitClient,
  type GitCommandRunner,
  type GitState,
  parseGitState,
} from "./capabilities/git-client.ts";
export type {
  LspClient,
  LspDefinitionResponse,
  LspHoverResponse,
  LspRange,
  LspReferencesResponse,
} from "./capabilities/lsp-client.ts";
export type { LuaExecutor } from "./capabilities/lua-executor.ts";
export type {
  ScriptCatalogEntry,
  ScriptRunner,
} from "./capabilities/script-runner.ts";
export type { OutputLine, Shell, ShellResult } from "./capabilities/shell.ts";
export type {
  DockerSpawnConfig,
  ThreadManager,
} from "./capabilities/thread-manager.ts";
export {
  isThreadId,
  type MessageIdx,
  type Role,
  type SubagentConfig,
  type ThreadId,
  type ThreadType,
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
  buildClonedFiles,
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
export {
  type GitContextUpdate,
  GitTracker,
  gitUpdateToText,
} from "./context/git-tracker.ts";
export type { Dispatch } from "./dispatch.ts";
export {
  Executor,
  type InitialDocIndex,
  resolveIndex,
} from "./edl/executor.ts";
export { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
export {
  type EdlRegisters,
  runScript,
  type ScriptFileSegment,
  splitScriptByFile,
} from "./edl/index.ts";
export { parse } from "./edl/parser.ts";
export type { FileMutationSummary } from "./edl/types.ts";
export { Emitter, type EventMap } from "./emitter.ts";
export type { Logger } from "./logger.ts";
export type { OpenAIAuth } from "./openai-auth.ts";
export type { AbsFilePath, Cwd } from "./paths.ts";
export type {
  ProviderName,
  ProviderOptions,
  ProviderProfile,
} from "./provider-options.ts";
export { AnthropicProvider } from "./providers/anthropic.ts";
export { withCacheControl } from "./providers/anthropic-cache.ts";
export { convertAnthropicMessagesToProvider } from "./providers/anthropic-conversion.ts";
export {
  CLAUDE_CODE_SPOOF_PROMPT,
  getContextWindowForModel,
  getMaxTokensForModel,
} from "./providers/anthropic-models.ts";
export type { AnthropicRunnerOptions } from "./providers/anthropic-runner.ts";
export {
  ABORT_MARKER_TEXT,
  AnthropicRunner,
} from "./providers/anthropic-runner.ts";
export type { BedrockProviderOptions } from "./providers/bedrock.ts";
export { BedrockProvider } from "./providers/bedrock.ts";
export { CodexAuth, CodexAuthError } from "./providers/codex-auth.ts";
export {
  MockAnthropicClient,
  MockStream,
} from "./providers/mock-anthropic-client.ts";
export {
  MockOpenAIClient,
  MockResponseStream,
} from "./providers/mock-openai-client.ts";
export { OpenAIProvider } from "./providers/openai.ts";
export {
  OpenAIRunner,
  type OpenAIStreamingClient,
} from "./providers/openai-runner.ts";
export { getProvider, setMockProvider } from "./providers/provider.ts";
export type {
  AgentHooks,
  AgentInput,
  AgentLog,
  AgentOptions,
  AgentPhase,
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
  RequestedTool,
  RetryStatus,
  Runner,
  StopReason,
  StreamingBlock,
  StreamStopReason,
  ToolExecutor,
  ToolOutcome,
  ToolResults,
  TurnResult,
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
  formatSystemInfo,
} from "./providers/system-prompt.ts";
export {
  buildSystemReminder,
  type ReminderKind,
} from "./providers/system-reminders.ts";
export type { ForkProvenance, ThreadLogEntry } from "./thread-logger.ts";
export type {
  EndTurnAction,
  EndTurnContext,
  HandoffAction,
  HandoffContext,
  SupervisorAction,
  ThreadSupervisor,
  YieldAction,
} from "./thread-supervisor.ts";
export {
  AutoCompactSupervisor,
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
export * as Edl from "./tools/edl.ts";
export * as FindReferences from "./tools/findReferences.ts";
export { formatToolSpec, formatToolSpecs } from "./tools/format-tool-spec.ts";
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
export * as NvimLua from "./tools/nvimLua.ts";
export * as RunScript from "./tools/run-script.ts";
export * as Scratchpad from "./tools/scratchpad.ts";
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
  shortenPath,
  threadConversationLogPath,
  threadMetaPath,
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
