export interface ContainerConfig {
  devcontainer: string;
  workspacePath: string;
  installCommand: string;
  volumeOverlays?: string[] | undefined;
}

export interface ProvisionResult {
  containerName: string;
  tempDir: string;
  imageName: string;
}
