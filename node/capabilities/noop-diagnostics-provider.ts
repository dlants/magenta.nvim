import type { DiagnosticsProvider } from "@magenta/core";

export class NoopDiagnosticsProvider implements DiagnosticsProvider {
  async getDiagnostics(): Promise<string> {
    return "Diagnostics are not available in Docker environment";
  }
}
