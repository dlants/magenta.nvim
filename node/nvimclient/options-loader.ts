import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadProjectSettings,
  loadUserSettings,
  type MagentaOptions,
  mergeOptions,
} from "./options.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export class DynamicOptionsLoader {
  private baseOptions: MagentaOptions;
  private cwd: NvimCwd;
  private homeDir: HomeDir;
  private logger: { warn: (msg: string) => void };

  private cachedOptions: MagentaOptions;
  private userSettingsMtime: number | undefined = undefined;
  private projectSettingsMtime: number | undefined = undefined;
  private userSettingsExisted = false;
  private projectSettingsExisted = false;

  constructor(
    baseOptions: MagentaOptions,
    cwd: NvimCwd,
    homeDir: HomeDir,
    logger: { warn: (msg: string) => void },
  ) {
    this.baseOptions = baseOptions;
    this.cwd = cwd;
    this.homeDir = homeDir;
    this.logger = logger;
    this.cachedOptions = this.reloadAndMerge();
  }

  getOptions(): MagentaOptions {
    const userSettingsPath = path.join(
      this.homeDir,
      ".magenta",
      "options.json",
    );
    const projectSettingsPath = path.join(this.cwd, ".magenta", "options.json");

    const userSettingsMtime = this.getFileMtime(userSettingsPath);
    const projectSettingsMtime = this.getFileMtime(projectSettingsPath);

    const userSettingsExistsNow = userSettingsMtime !== undefined;
    const projectSettingsExistsNow = projectSettingsMtime !== undefined;

    const needsReload =
      this.userSettingsMtime !== userSettingsMtime ||
      this.projectSettingsMtime !== projectSettingsMtime ||
      this.userSettingsExisted !== userSettingsExistsNow ||
      this.projectSettingsExisted !== projectSettingsExistsNow;

    if (needsReload) {
      this.userSettingsMtime = userSettingsMtime;
      this.projectSettingsMtime = projectSettingsMtime;
      this.userSettingsExisted = userSettingsExistsNow;
      this.projectSettingsExisted = projectSettingsExistsNow;
      this.cachedOptions = this.reloadAndMerge();
    }

    return this.cachedOptions;
  }

  private getFileMtime(filePath: string): number | undefined {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private reloadAndMerge(): MagentaOptions {
    const userSettings = loadUserSettings(this.homeDir, this.logger);
    let merged = mergeOptions(this.baseOptions, userSettings ?? {});
    const projectSettings = loadProjectSettings(this.cwd, this.logger);
    merged = mergeOptions(merged, projectSettings ?? {});
    return merged;
  }
}
