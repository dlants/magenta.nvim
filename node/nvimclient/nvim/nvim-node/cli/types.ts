export type Params = [type: string, name: string][];

export type ApiMeta = {
  version: {
    major: number;
    minor: number;
    patch: number;
    prerelease: boolean;
    api_level: number;
    api_compatible: number;
    api_prerelease: boolean;
  };
  functions: {
    name: string;
    since: number;
    parameters: Params;
    return_type: string;
    method: boolean;
    deprecated_since?: number;
  }[];
  ui_events: {
    name: string;
    parameters: Params;
    since: number;
  }[];
  ui_options: string[];
  error_types: Record<string, { id: number }>;
  types: Record<string, { id: number; prefix: string }>;
};
