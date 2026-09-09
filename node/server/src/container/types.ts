export interface ContainerConfig {
  dockerfile: string;
  workspacePath: string;
  installCommand?: string;
}

export interface ProvisionResult {
  containerName: string;
  imageName: string;
}

export interface TeardownResult {
  syncedFiles: number;
}
