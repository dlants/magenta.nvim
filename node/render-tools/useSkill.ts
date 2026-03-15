import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
  UseSkill,
} from "@magenta/core";
import { d, type VDOMNode, withCode, withInlineCode } from "../tea/view.ts";

type UseSkillProgress = UseSkill.UseSkillProgress;
type OutputLine = { stream: "stdout" | "stderr"; text: string };

type Input = {
  skill: string;
  input?: Record<string, unknown>;
};

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: UseSkillProgress,
): VDOMNode {
  const input = request.input as Input;
  const skillName = input.skill;
  return progress?.startTime !== undefined
    ? d`⚡⚙️ (${String(Math.floor((Date.now() - progress.startTime) / 1000))}s) use_skill: ${withInlineCode(d`\`${skillName}\``)}`
    : d`⚡⏳ use_skill: ${withInlineCode(d`\`${skillName}\``)}`;
}

export function renderInFlightPreview(
  progress: UseSkillProgress,
  getDisplayWidth: () => number,
): VDOMNode {
  const formattedOutput = formatOutputPreview(
    progress.liveOutput,
    getDisplayWidth,
  );
  return formattedOutput
    ? withCode(
        d`\`\`\`
${formattedOutput}
\`\`\``,
      )
    : d``;
}

export function renderInFlightDetail(progress: UseSkillProgress): VDOMNode {
  return renderOutputDetail(progress.liveOutput);
}

function formatOutputPreview(
  output: OutputLine[],
  getDisplayWidth: () => number,
): string {
  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;
  const lastTenLines = output.slice(-10);
  for (const line of lastTenLines) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    const displayWidth = getDisplayWidth() - 5;
    const displayText =
      line.text.length > displayWidth
        ? `${line.text.substring(0, displayWidth)}...`
        : line.text;
    formattedOutput += `${displayText}\n`;
  }
  return formattedOutput;
}

function renderOutputDetail(output: OutputLine[]): VDOMNode {
  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;
  for (const line of output) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    formattedOutput += `${line.text}\n`;
  }
  return d`${withCode(d`\`\`\`
${formattedOutput}
\`\`\``)}`;
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const skillName = input.skill;
  const result = info.result.result;
  if (result.status === "error") {
    return d`🔧❌ use_skill: ${withInlineCode(d`\`${skillName}\``)} - error`;
  }
  return d`🔧✅ use_skill: ${withInlineCode(d`\`${skillName}\``)}`;
}

export function renderCompletedPreview(
  info: CompletedToolInfo,
  getDisplayWidth: () => number,
): VDOMNode {
  const result = info.result.result;
  if (result.status !== "ok" || result.value.length === 0) {
    return d``;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d``;
  }

  const text = firstValue.text;
  const lines = text.split("\n");
  const maxLines = 10;
  const maxLength = getDisplayWidth() - 5;
  let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  previewLines = previewLines.map((line) =>
    line.length > maxLength ? `${line.substring(0, maxLength)}...` : line,
  );
  const previewText = previewLines.join("\n");

  return d`${withCode(d`\`\`\`
${previewText}
\`\`\``)}`;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const skillName = input.skill;
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return d`skill: ${withInlineCode(d`\`${skillName}\``)}\n${result.status === "error" ? d`❌ ${result.error}` : d``}`;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d`skill: ${withInlineCode(d`\`${skillName}\``)}`;
  }

  return d`skill: ${withInlineCode(d`\`${skillName}\``)}
${withCode(d`\`\`\`
${firstValue.text}
\`\`\``)}`;
}
