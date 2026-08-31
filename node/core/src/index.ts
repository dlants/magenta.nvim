export {
  type ActiveToolEntry,
  Agent,
  type AgentAction,
  type AgentContext,
  type AgentPhase,
  type BeforeRequestDecision,
  type EnvironmentConfig,
  type InputMessage,
  phaseActiveTools,
  phaseLabel,
  phaseStreamingBlock,
  type ThreadState,
  type ToolExecutor,
  type ToolOutcome,
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
export {
  type CompactionOutcome,
  type CompactionRunId,
  type CompactionRunState,
  type Compactor,
  type CompactSuspendReason,
  compactionRunChunkIndex,
  compactionRunThreadIds,
  runSubmission,
  ThreadCompactor,
  type ThreadCompactorEvents,
} from "./compaction/index.ts";
export { provisionContainer } from "./container/provision.ts";
export { teardownContainer } from "./container/teardown.ts";
export type {
  ContainerConfig,
  ProvisionResult,
  TeardownResult,
} from "./container/types.ts";
export {
  type BufNr,
  type Comment,
  type CommentCloseReason,
  type CommentId,
  type CommentLocation,
  type CommentMessage,
  CommentStore,
  type CommentStoreEvents,
  type CommentUpdateEntry,
  commentUpdatesToText,
} from "./context/comment-store.ts";
export { CommentSupervisor } from "./context/comment-supervisor.ts";
export {
  buildClonedFiles,
  ContextManager,
  type ContextManagerEvents,
  cloneContextManager,
  type DiffUpdate,
  type FileDeletedUpdate,
  type Files as ContextFiles,
  type FileUpdate,
  type FileUpdates,
  type Patch,
  type WholeFileUpdate,
} from "./context/context-manager.ts";
export { FileContextSupervisor } from "./context/file-context-supervisor.ts";
export { GitSupervisor } from "./context/git-supervisor.ts";
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
  AnthropicInferenceManager,
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
  OpenAIInferenceManager,
  type OpenAIStreamingClient,
} from "./providers/openai-runner.ts";
export { getProvider, setMockProvider } from "./providers/provider.ts";
export type {
  AgentInput,
  AgentLog,
  FinalizeReason,
  InferenceOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  OnRequestUpdate,
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
  RequestResult,
  RequestUpdate,
  RetryStatus,
  StopReason,
  StreamingBlock,
  StreamStopReason,
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
} from "./submission/index.ts";
export { Thread, type ThreadCallbacks } from "./thread.ts";
export type {
  AgentHooks,
  OnUpdate,
  QueuedMessage,
  SendOptions,
  SendResult,
  ThreadResult,
  ThreadSendResult,
  TurnActivity,
  YieldValue,
} from "./thread-api.ts";
export type { ForkProvenance, ThreadLogEntry } from "./thread-logger.ts";
export type {
  EndTurnAction,
  EndTurnContext,
  PlainStopSuspendReason,
  RequestAction,
  RequestContext,
  SupervisorAction,
  SuspendReason,
  ThreadSupervisor,
  YieldAction,
} from "./thread-supervisor.ts";
export {
  AutoCompactSupervisor,
  composeSupervisors,
  MaxTokensSupervisor,
  SubagentSupervisor,
  SystemInfoSupervisor,
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
  extractPartialReplies,
  type PartialReply,
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
export * as Reply from "./tools/reply.ts";
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
