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
  OnToolAppliedHook,
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
  type ScriptInvocationId,
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
export {
  type CompactionOutcome,
  type CompactionRunId,
  type CompactionRunState,
  type Compactor,
  type CompactSuspendReason,
  compactionRunChunkIndex,
  compactionRunThreadIds,
  ThreadCompactor,
  type ThreadCompactorDeps,
  type ThreadCompactorEvents,
} from "./compaction/index.ts";
export {
  type BudgetDecision,
  TokenBudget,
} from "./compaction/token-budget.ts";
export { provisionContainer } from "./container/provision.ts";
export { teardownContainer } from "./container/teardown.ts";
export type {
  ContainerConfig,
  ProvisionResult,
  TeardownResult,
} from "./container/types.ts";
export type { Dispatch } from "./dispatch.ts";
export { DockerSupervisor } from "./docker-supervisor.ts";
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
export {
  loopActiveTools,
  loopLabel,
  loopStreamingBlock,
  type ThreadLoopState,
} from "./loop-state.ts";
export type { OpenAIAuth } from "./openai-auth.ts";
export type { AbsFilePath, Cwd } from "./paths.ts";
export type {
  ProviderName,
  ProviderOptions,
  ProviderProfile,
} from "./provider-options.ts";
export {
  AnthropicProvider,
  anthropicInferenceOptions,
} from "./providers/anthropic.ts";
export { withCacheControl } from "./providers/anthropic-cache.ts";
export { convertAnthropicMessagesToProvider } from "./providers/anthropic-conversion.ts";
export type { AnthropicInferenceOptions } from "./providers/anthropic-inference.ts";
export { AnthropicInferenceManager } from "./providers/anthropic-inference.ts";
export {
  CLAUDE_CODE_SPOOF_PROMPT,
  getContextWindowForModel,
  getMaxTokensForModel,
} from "./providers/anthropic-models.ts";
export type { BedrockProviderOptions } from "./providers/bedrock.ts";
export { BedrockProvider } from "./providers/bedrock.ts";
export { CodexAuth, CodexAuthError } from "./providers/codex-auth.ts";
export { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
export {
  MockAnthropicClient,
  MockStream,
} from "./providers/mock-anthropic-client.ts";
export {
  MockOpenAIClient,
  MockResponseStream,
} from "./providers/mock-openai-client.ts";
export { OpenAIProvider, openaiInferenceOptions } from "./providers/openai.ts";
export {
  OpenAIInferenceManager,
  type OpenAIStreamingClient,
} from "./providers/openai-inference.ts";
export { getProvider, setMockProvider } from "./providers/provider.ts";
export type {
  AgentInput,
  AgentLog,
  CreateInferenceManagerOptions,
  FinalizeReason,
  InferenceOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  OnStreamEvent,
  Provider,
  ProviderBlockDeltaEvent,
  ProviderBlockStartEvent,
  ProviderBlockStopEvent,
  ProviderContextUpdateContent,
  ProviderDocumentContent,
  ProviderImageContent,
  ProviderMessage,
  ProviderMessageContent,
  ProviderRedactedThinkingContent,
  ProviderServerToolUseContent,
  ProviderSetting,
  ProviderStreamEvent,
  ProviderStreamRequest,
  ProviderSystemReminderContent,
  ProviderTextContent,
  ProviderThinkingContent,
  ProviderToolResult,
  ProviderToolSpec,
  ProviderToolUseContent,
  ProviderToolUseRequest,
  ProviderToolUseResponse,
  ProviderWebSearchCitation,
  ProviderWebSearchToolResult,
  RequestedTool,
  RequestResult,
  RetryStatus,
  StopReason,
  StreamEvent,
  StreamingBlock,
  StreamStopReason,
  ToolResultContent,
  ToolResultInput,
  ToolResults,
  ToolResultValue,
  Usage,
} from "./providers/provider-types.ts";
export { PROVIDER_NAMES } from "./providers/provider-types.ts";
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
export type {
  JSONSchema,
  MagentaToScript,
  Result as ScriptResult,
  ScriptMeta,
  ScriptToMagenta,
  ThreadOptions,
} from "./scripts/protocol.ts";
export {
  type ScriptInvocation,
  type ScriptInvocationEntry,
  type ScriptInvocationState,
  ScriptManager,
  type ScriptSandboxCapability,
  type ScriptSandboxRoot,
  type ScriptThreadResult,
} from "./scripts/script-manager.ts";
export {
  type PreparedThread,
  Session,
  type SessionCreateOptions,
  type SessionHost,
  type SessionId,
  type SessionThread,
  type ThreadPreparation,
} from "./session.ts";
export {
  compactPrompt,
  type Delivery,
  type PendingMessage,
  parseCompact,
  parseDelivery,
  pendingMessage,
  type ResolvedSubmission,
  type ResolveSubmission,
  renderPending,
  resolveAsText,
  type Submission,
  type SubmissionInput,
} from "./submission/index.ts";
export type {
  DeferredDelivery,
  QueueEntry,
  Queues,
} from "./submission/mailbox.ts";
export {
  buildClonedFiles,
  type DiffUpdate,
  type FileDeletedUpdate,
  FileSupervisor,
  type FileSupervisorCallbacks,
  type Files as ContextFiles,
  type FileUpdate,
  type FileUpdates,
  type Patch,
  type WholeFileUpdate,
} from "./supervisors/file-supervisor.ts";
export {
  type GitContextUpdate,
  GitSupervisor,
  GitTracker,
  gitUpdateToText,
} from "./supervisors/git-supervisor.ts";
export { type HistoryIdx, PRE_HISTORY } from "./supervisors/history.ts";
export {
  type CompactThreadContext,
  type ContextFileAccess,
  type EnvironmentConfig,
  type ReminderThreadContext,
  Thread,
  type ThreadCallbacks,
  type ThreadContext,
  type ThreadContextBase,
  type YieldState,
} from "./thread.ts";
export type {
  CoreLoopResult,
  OnUpdate,
  QueuedMessage,
  RestResult,
  ThreadResult,
  YieldValue,
} from "./thread-api.ts";
export {
  type AssembledThread,
  assembleThread,
  type ChatThreadPolicy,
  type PreparedThreadContext,
  type ThreadInitialization,
  TitleSupervisor,
} from "./thread-assembly.ts";
export type { ForkProvenance, ThreadLogEntry } from "./thread-logger.ts";
export { flushArchive, threadArchive } from "./thread-logger.ts";
export type {
  EditedFile,
  EditedFileGroup,
  EndTurnAction,
  EndTurnContext,
  PlainSuspendReason,
  RequestContext,
  SupervisorAction,
  SuspendReason,
  ToolLoopSupervisor,
  TurnSupervisor,
  YieldAction,
} from "./thread-supervisor.ts";
export {
  EditedFilesSupervisor,
  MaxTokensSupervisor,
  SubagentSupervisor,
  SystemInfoSupervisor,
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";
export {
  type BeforeRequestDecision,
  type LoopState,
  runToolLoop,
  type ToolExecutor,
  type ToolOutcome,
} from "./tool-loop.ts";
export type {
  ActiveToolEntry,
  CompletedToolInfo,
  DisplayContext,
  ExecutedToolResult,
  ExecutingToolInvocation,
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
export {
  type ClientToolContext,
  type ClientToolCreator,
  type CreateToolContext,
  clientToolCreator,
  createTool,
} from "./tools/create-tool.ts";
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
export { escalateToSigkill, terminateProcess } from "./utils/process.ts";
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
