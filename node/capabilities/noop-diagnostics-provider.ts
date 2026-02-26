import type { DiagnosticsProvider } from "@magenta/core";

export class NoopDiagnosticsProvider implements DiagnosticsProvider {
  getDiagnostics(): Promise<string> {
    return Promise.resolve(
      "Diagnostics are not available in Docker environment",
    );
  }
}
