import type { ApprovalId } from "../capabilities/sandbox-violation-handler.ts";
import type {
  ReflectAnchor,
  ScriptInvocationId,
  ThreadId,
} from "../chat-types.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import type { SessionId } from "../session.ts";
import type { Delivery, SubmissionInput } from "../submission/index.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";
import type { ProtocolSubmissionResult } from "./state.ts";

export type Operation =
  | { type: "thread.create"; sessionId: SessionId; agent?: string }
  | {
      type: "thread.fork";
      threadId: ThreadId;
      nativeMessageIdx?: NativeMessageIdx;
    }
  | { type: "thread.reflect"; threadId: ThreadId; anchor?: ReflectAnchor }
  | { type: "thread.delete"; threadId: ThreadId }
  | {
      type: "thread.submit";
      threadId: ThreadId;
      input: SubmissionInput;
      delivery?: Delivery;
    }
  | { type: "thread.retry"; threadId: ThreadId }
  | { type: "thread.abort"; threadId: ThreadId }
  | { type: "thread.setTitle"; threadId: ThreadId; title: string }
  | { type: "thread.recordActivity"; threadId: ThreadId }
  | {
      type: "thread.addContextFiles";
      threadId: ThreadId;
      files: ReadonlyArray<UnresolvedFilePath | AbsFilePath>;
    }
  | { type: "thread.removeContextFile"; threadId: ThreadId; file: AbsFilePath }
  | { type: "tool.abort"; threadId: ThreadId; toolRequestId: ToolRequestId }
  | {
      type: "approval.approve" | "approval.reject";
      threadId: ThreadId;
      approvalId: ApprovalId;
    }
  | {
      type:
        | "approval.approveAll"
        | "approval.rejectAll"
        | "approval.approveAllInSubtree";
      threadId: ThreadId;
    }
  | { type: "sandbox.toggleBypass"; threadId: ThreadId }
  | { type: "session.setActiveProfile"; sessionId: SessionId; name: string }
  | {
      type: "script.run";
      sessionId: SessionId;
      name: string;
      parameters: unknown;
    }
  | {
      type: "script.abort" | "script.delete" | "script.toggleSandbox";
      invocationId: ScriptInvocationId;
    }
  | { type: "script.discover"; sessionId: SessionId };

type Ok = { type: "ok" };
type Aborted = { type: "aborted" };
type Created = { type: "created"; threadId: ThreadId };
type Submitted = { type: "submitted"; submission: ProtocolSubmissionResult };
export type OperationError = { type: "error"; message: string };

/** The success result(s) of each operation type. `threadAborted.unsent` is
 * the thread's unsent queued input, rendered as text. */
export type OperationSuccessMap = {
  "thread.create": Created | Aborted;
  "thread.fork": Created | Aborted;
  "thread.reflect": Created | Aborted;
  "thread.delete": Ok;
  "thread.submit": Submitted | { type: "queued" };
  "thread.retry": Submitted;
  "thread.abort": { type: "threadAborted"; unsent: ReadonlyArray<string> };
  "thread.setTitle": Ok;
  "thread.recordActivity": Ok;
  "thread.addContextFiles": Ok;
  "thread.removeContextFile": Ok;
  "tool.abort": Ok;
  "approval.approve": Ok;
  "approval.reject": Ok;
  "approval.approveAll": Ok;
  "approval.rejectAll": Ok;
  "approval.approveAllInSubtree": Ok;
  "sandbox.toggleBypass": Ok;
  "session.setActiveProfile": Ok;
  "script.run": { type: "started"; invocationId: ScriptInvocationId };
  "script.abort": Ok;
  "script.delete": Ok;
  "script.toggleSandbox": Ok;
  "script.discover": Ok;
};

export type OperationType = Operation["type"];

/** The operation variant(s) whose `type` includes `K`. */
export type OperationOf<K extends OperationType> = Operation extends infer O
  ? O extends Operation
    ? K extends O["type"]
      ? O
      : never
    : never
  : never;

export type OperationResultFor<O extends Operation> =
  | OperationSuccessMap[O["type"]]
  | OperationError;

export type OperationResult = OperationResultFor<Operation>;
