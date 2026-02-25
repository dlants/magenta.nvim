export interface DiagnosticsProvider {
  getDiagnostics(): Promise<string>;
}
