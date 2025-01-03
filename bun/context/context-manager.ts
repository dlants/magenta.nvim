import fs from "node:fs";
import path from "node:path";
import { d, withBindings, type View } from "../tea/view";
import type { Dispatch, Update } from "../tea/tea";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { ProviderMessage } from "../providers/provider";
import { getcwd } from "../nvim/nvim";
import type { Nvim } from "bunvim";
import { getBufferIfOpen } from "../utils/buffers";

export type Model = {
  files: {
    [absFilePath: string]: { relFilePath: string };
  };
};

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: string;
      absFilePath: string;
    }
  | {
      type: "remove-file-context";
      absFilePath: string;
    };

export function init({ nvim }: { nvim: Nvim }) {
  function initModel(): Model {
    return {
      files: {},
    };
  }
  const update: Update<Msg, Model> = (msg: Msg, model: Model) => {
    switch (msg.type) {
      case "add-file-context":
        return [
          {
            ...model,
            files: {
              ...model.files,
              [msg.absFilePath]: { relFilePath: msg.relFilePath },
            },
          },
        ];
      case "remove-file-context":
        delete model.files[msg.absFilePath];
        return [model];
      default:
        assertUnreachable(msg);
    }
  };

  const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
    model,
    dispatch,
  }) => {
    const fileContext = [];
    for (const absFilePath in model.files) {
      fileContext.push(
        withBindings(d`file: \`${model.files[absFilePath].relFilePath}\`\n`, {
          "<CR>": () => dispatch({ type: "remove-file-context", absFilePath }),
        }),
      );
    }

    return d`\
# context:
${fileContext}`;
  };

  function isContextEmpty(model: Model) {
    return Object.keys(model.files).length == 0;
  }

  async function getContextMessage(
    model: Model,
  ): Promise<ProviderMessage | undefined> {
    if (isContextEmpty(model)) {
      return undefined;
    }

    const cwd = await getcwd(nvim);
    const fileContents = await Promise.all(
      Object.keys(model.files).map((absFilePath) =>
        getFileContents({ absFilePath, cwd }),
      ),
    );

    return {
      role: "user",
      content: `\
Files:
${fileContents.join("\n\n")}`,
    };
  }

  async function getFileContents({
    absFilePath,
    cwd,
  }: {
    absFilePath: string;
    cwd: string;
  }): Promise<string> {
    const relativePath = path.relative(cwd, absFilePath);
    const bufferContents = await getBufferIfOpen({
      relativePath,
      context: { nvim },
    });

    if (bufferContents.status == "ok") {
      return renderFile({
        relFilePath: relativePath,
        content: bufferContents.result,
      });
    } else if (bufferContents.status == "error") {
      return `\
Error trying to read file \`${relativePath}\`: ${bufferContents.error}`;
    }

    try {
      const fileContent = await fs.promises.readFile(absFilePath, "utf-8");
      return renderFile({ relFilePath: relativePath, content: fileContent });
    } catch (error) {
      return `\
Error trying to read file \`${relativePath}\`: ${(error as Error).message}`;
    }
  }

  function renderFile({
    relFilePath,
    content,
  }: {
    relFilePath: string;
    content: string;
  }) {
    return `\
Here are the contents of file \`${relFilePath}\`:
\`\`\`
${content}
\`\`\``;
  }

  return {
    isContextEmpty,
    initModel,
    update,
    view,
    getContextMessage,
  };
}
