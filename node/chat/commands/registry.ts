import type { Command, MessageContext } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { forkCommand } from "./fork.ts";
import { compactCommand } from "./compact.ts";
import { fileCommand } from "./file.ts";
import { diffCommand, stagedCommand } from "./diff.ts";
import { diagCommand, diagnosticsCommand } from "./diagnostics.ts";
import { qfCommand, quickfixCommand } from "./quickfix.ts";
import { bufCommand, buffersCommand } from "./buffers.ts";

import type { CustomCommand as CustomCommandConfig } from "../../options.ts";

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  constructor() {
    this.registerBuiltinCommands();
  }

  private registerBuiltinCommands(): void {
    const builtinCommands: Command[] = [
      forkCommand,
      compactCommand,
      fileCommand,
      diffCommand,
      stagedCommand,
      diagCommand,
      diagnosticsCommand,
      qfCommand,
      quickfixCommand,
      bufCommand,
      buffersCommand,
    ];

    for (const command of builtinCommands) {
      this.registerCommand(command);
    }
  }

  registerCommand(command: Command): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command ${command.name} is already registered`);
    }
    this.commands.set(command.name, command);
  }

  registerCustomCommand(config: CustomCommandConfig): void {
    const command: Command = {
      name: config.name,
      // Regex needs to be generated for user-defined commands for ease of configuring
      // To prevent "@testing" from triggering a command called "@test", we add
      // a word boundary to the end.
      //
      // Word boundaries don't work after non-word chars, so for commands
      // that end in punctuation (e.g., "@test[1]"), we use a lookahead instead
      pattern: new RegExp(
        config.name.match(/\w$/)
          ? `${this.escapeRegExp(config.name)}\\b`
          : `${this.escapeRegExp(config.name)}(?!\\w)`,
      ),
      execute(): Promise<ProviderMessageContent[]> {
        return Promise.resolve([
          {
            type: "text",
            text: config.text,
          },
        ]);
      },
    };

    if (config.description !== undefined) {
      command.description = config.description;
    }

    this.registerCommand(command);
  }

  private escapeRegExp(str: string): string {
    // Custom commands can have regex metacharacters like "@test[1]"
    // We need to escape these so they match literally in the regex pattern,
    // not as regex metacharacters
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  getCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  async processMessage(
    text: string,
    context: MessageContext,
  ): Promise<{
    processedText: string;
    additionalContent: ProviderMessageContent[];
  }> {
    const additionalContent: ProviderMessageContent[] = [];
    let processedText = text;

    // Handle @async specially - strip it from the beginning
    if (processedText.trim().startsWith("@async")) {
      processedText = processedText.replace(/^\s*@async\s*/, "");
    }

    // Find all command matches in the text
    for (const command of this.commands.values()) {
      const regex = new RegExp(command.pattern.source, "g");
      let match;
      while ((match = regex.exec(processedText)) !== null) {
        const content = await command.execute(match, context);
        additionalContent.push(...content);
      }
    }

    return { processedText, additionalContent };
  }
}
