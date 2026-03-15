import type { ToolSkillConfig } from "../provider-options.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";
import { executeSkill, getSkillDocs } from "./skill/executable.ts";
import { buildSkillDescription, findSkill } from "./skill/helpers.ts";

export type Input = {
  skill: string;
  input?: Record<string, unknown> | undefined;
};

export type ToolRequest = GenericToolRequest<"use_skill", Input>;

export function validateInput(args: { [key: string]: unknown }): Result<Input> {
  if (typeof args.skill !== "string" || args.skill.length === 0) {
    return {
      status: "error",
      error: `Expected 'skill' to be a non-empty string but got ${typeof args.skill}`,
    };
  }

  const result: Input = { skill: args.skill };

  if (args.input !== undefined) {
    if (typeof args.input !== "object" || args.input === null) {
      return {
        status: "error",
        error: `Expected 'input' to be an object but got ${typeof args.input}`,
      };
    }
    result.input = args.input as Record<string, unknown>;
  }

  return {
    status: "ok",
    value: result,
  };
}

export function getSpec(skills: ToolSkillConfig[]): ProviderToolSpec {
  return {
    name: "use_skill" as ToolName,
    description: buildSkillDescription(skills),
    input_schema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "The name of the skill to invoke",
        },
        input: {
          type: "object",
          description:
            "Input parameters for the skill. Omit to get usage docs.",
        },
      },
      required: ["skill"],
    },
  };
}

export const spec: ProviderToolSpec = getSpec([]);

export function execute(
  request: ToolRequest,
  context: {
    toolSkills: ToolSkillConfig[];
    requestRender: () => void;
  },
): ToolInvocation {
  const promise = (async (): Promise<ProviderToolResult> => {
    const skill = findSkill(context.toolSkills, request.input.skill);
    if (!skill) {
      const available = context.toolSkills.map((s) => s.name).join(", ");
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Unknown skill '${request.input.skill}'. Available skills: ${available}`,
        },
      };
    }

    if (request.input.input === undefined) {
      const docs = await getSkillDocs(skill.command);
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: docs }],
        },
      };
    }

    const result = await executeSkill(skill.command, request.input.input);
    if (result.status === "error") {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: result.error ?? "Skill execution failed",
        },
      };
    }

    return {
      type: "tool_result",
      id: request.id,
      result: {
        status: "ok",
        value: [{ type: "text", text: result.value ?? "" }],
      },
    };
  })();

  return {
    promise,
    abort: () => {
      // Skills are short-lived processes; aborting is a no-op
    },
  };
}
