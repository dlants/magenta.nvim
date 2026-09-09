export interface Shell {
  execute(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
  ): Promise<ShellResult>;
  terminate(): void;
}

export type ShellResult = {
  exitCode: number;
  signal: NodeJS.Signals | undefined;
  output: OutputLine[];
  logFilePath: string | undefined;
  durationMs: number;
};

export type OutputLine = {
  stream: "stdout" | "stderr";
  text: string;
};
