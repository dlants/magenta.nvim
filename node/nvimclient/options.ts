import {
  BUILTIN_SDK_PATH,
  BUILTIN_SKILLS_PATH,
  getActiveProfile,
  PLUGIN_ROOT,
  type Profile,
  type ServerOptions,
} from "@magenta/server";

export {
  BUILTIN_SDK_PATH,
  BUILTIN_SKILLS_PATH,
  getActiveProfile,
  PLUGIN_ROOT,
  type Profile,
  type ServerOptions,
};

export type HSplitWindowDimensions = {
  displayHeightPercentage: number;
  inputHeightPercentage: number;
};

export type VSplitWindowDimensions = {
  displayHeightPercentage: number;
};

export type TabWindowDimensions = {
  displayHeightPercentage: number;
};

export type SidebarPositions =
  | "left"
  | "right"
  | "below"
  | "above"
  | "tab"
  | "leftbelow"
  | "leftabove"
  | "rightbelow"
  | "rightabove";
export type SidebarPositionOpts = {
  left: VSplitWindowDimensions;
  right: VSplitWindowDimensions;
  below: HSplitWindowDimensions;
  above: HSplitWindowDimensions;
  tab: TabWindowDimensions;
};

export const DEFAULT_SIDEBAR_POSITION_OPTS: SidebarPositionOpts = {
  above: {
    displayHeightPercentage: 0.3,
    inputHeightPercentage: 0.1,
  },
  below: {
    displayHeightPercentage: 0.3,
    inputHeightPercentage: 0.1,
  },
  tab: {
    displayHeightPercentage: 0.8,
  },
  left: {
    displayHeightPercentage: 0.8,
  },
  right: {
    displayHeightPercentage: 0.8,
  },
};

function parseSidebarPosition(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): SidebarPositions | undefined {
  if (
    input === "right" ||
    input === "left" ||
    input === "above" ||
    input === "below" ||
    input === "tab" ||
    input === "leftbelow" ||
    input === "leftabove" ||
    input === "rightbelow" ||
    input === "rightabove"
  ) {
    return input as SidebarPositions;
  } else if (input !== undefined) {
    logger?.warn(
      `Invalid sidebarPosition: ${JSON.stringify(input)}, must be "left", "right", "above", "below", "tab", "leftbelow", "leftabove", "rightbelow", or "rightabove"`,
    );
  }
  return undefined;
}

function parseSidebarPositionOpts(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): Partial<SidebarPositionOpts> | undefined {
  if (typeof input !== "object" || input === null) {
    logger?.warn("sidebarPositionOpts must be an object");
    return undefined;
  }

  const opts = input as { [key: string]: unknown };
  const result: Partial<SidebarPositionOpts> = {};

  // Parse left/right (VSplitWindowDimensions)
  for (const side of ["left", "right"] as const) {
    if (side in opts) {
      const sideOpts = opts[side];
      if (typeof sideOpts === "object" && sideOpts !== null) {
        const sideOptsObj = sideOpts as { [key: string]: unknown };
        if (typeof sideOptsObj.displayHeightPercentage === "number") {
          result[side] = {
            displayHeightPercentage: sideOptsObj.displayHeightPercentage,
          };
        } else {
          logger?.warn(
            `sidebarPositionOpts.${side} must have displayHeightPercentage`,
          );
        }
      } else {
        logger?.warn(`sidebarPositionOpts.${side} must be an object`);
      }
    }
  }

  // Parse above/below (HSplitWindowDimensions)
  for (const side of ["above", "below"] as const) {
    if (side in opts) {
      const sideOpts = opts[side];
      if (typeof sideOpts === "object" && sideOpts !== null) {
        const sideOptsObj = sideOpts as { [key: string]: unknown };
        if (
          typeof sideOptsObj.displayHeightPercentage === "number" &&
          typeof sideOptsObj.inputHeightPercentage === "number"
        ) {
          result[side] = {
            displayHeightPercentage: sideOptsObj.displayHeightPercentage,
            inputHeightPercentage: sideOptsObj.inputHeightPercentage,
          };
        } else {
          logger?.warn(
            `sidebarPositionOpts.${side} must have displayHeightPercentage and inputHeightPercentage`,
          );
        }
      } else {
        logger?.warn(`sidebarPositionOpts.${side} must be an object`);
      }
    }
  }

  // Parse tab (TabWindowDimensions)
  if ("tab" in opts) {
    const tabOpts = opts.tab;
    if (typeof tabOpts === "object" && tabOpts !== null) {
      const tabOptsObj = tabOpts as { [key: string]: unknown };
      if (typeof tabOptsObj.displayHeightPercentage === "number") {
        result.tab = {
          displayHeightPercentage: tabOptsObj.displayHeightPercentage,
        };
      } else {
        logger?.warn(
          "sidebarPositionOpts.tab must have displayHeightPercentage",
        );
      }
    } else {
      logger?.warn("sidebarPositionOpts.tab must be an object");
    }
  }

  // Return undefined if no valid options were parsed
  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result;
}

/** Editor-side options, parsed from lua `setup()`. Everything that configures
 * execution comes from the server's options files instead. */
export type ClientOptions = {
  sidebarPosition: SidebarPositions;
  sidebarPositionOpts: SidebarPositionOpts;
  lspDebounceMs?: number;
  debug?: boolean;
  chimeVolume?: number;
  bellOnNotify?: boolean;
};

/** The view of options the client works with: server configuration plus the
 * editor's own. */
export type MagentaOptions = ServerOptions & ClientOptions;

/** Keys that used to be accepted by lua `setup()` but now configure the
 * server, which reads them only from its options files. */
export const SERVER_OPTION_KEYS = [
  "profiles",
  "activeProfile",
  "sandbox",
  "autoContext",
  "hierarchyContextFileNames",
  "skillsPaths",
  "scriptsPaths",
  "suppressProjectSkills",
  "agentsPaths",
  "maxConcurrentSubagents",
  "maxConcurrentFastSubagents",
  "autoCompactThreshold",
  "autoCompactPrompt",
  "mcpServers",
  "customCommands",
  "watchers",
] as const satisfies readonly (keyof ServerOptions)[];

export function parseClientOptions(
  inputOptions: unknown,
  logger: { warn: (msg: string) => void },
): ClientOptions {
  const options: ClientOptions = {
    sidebarPosition: "left",
    sidebarPositionOpts: structuredClone(DEFAULT_SIDEBAR_POSITION_OPTS),
  };
  if (typeof inputOptions !== "object" || inputOptions === null) {
    return options;
  }
  const inputOptionsObj = inputOptions as { [key: string]: unknown };
  const serverKeys = SERVER_OPTION_KEYS.filter((k) => k in inputOptionsObj);
  if (serverKeys.length > 0) {
    logger.warn(
      `Ignoring server options passed to setup(): ${serverKeys.join(", ")}. Move them to ~/.magenta/options.json (or <project>/.magenta/options.json).`,
    );
  }
  const sidebarPosition = parseSidebarPosition(
    inputOptionsObj.sidebarPosition,
    logger,
  );
  if (sidebarPosition) {
    options.sidebarPosition = sidebarPosition;
  }
  if ("sidebarPositionOpts" in inputOptionsObj) {
    const sidebarPositionOpts = parseSidebarPositionOpts(
      inputOptionsObj.sidebarPositionOpts,
      logger,
    );
    // Per-position merge: a config that names only one position must not
    // erase the defaults for the others.
    options.sidebarPositionOpts = {
      ...options.sidebarPositionOpts,
      ...sidebarPositionOpts,
    };
  }
  if (
    "lspDebounceMs" in inputOptionsObj &&
    typeof inputOptionsObj.lspDebounceMs === "number" &&
    inputOptionsObj.lspDebounceMs > 0
  ) {
    options.lspDebounceMs = inputOptionsObj.lspDebounceMs;
  }

  // Parse debug flag
  if (
    "debug" in inputOptionsObj &&
    typeof inputOptionsObj.debug === "boolean"
  ) {
    options.debug = inputOptionsObj.debug;
  }

  if (
    "chimeVolume" in inputOptionsObj &&
    typeof inputOptionsObj.chimeVolume === "number" &&
    inputOptionsObj.chimeVolume >= 0 &&
    inputOptionsObj.chimeVolume <= 1
  ) {
    options.chimeVolume = inputOptionsObj.chimeVolume;
  } else if ("chimeVolume" in inputOptionsObj) {
    logger.warn("chimeVolume must be a number between 0.0 and 1.0");
  }

  if (
    "bellOnNotify" in inputOptionsObj &&
    typeof inputOptionsObj.bellOnNotify === "boolean"
  ) {
    options.bellOnNotify = inputOptionsObj.bellOnNotify;
  }
  return options;
}
