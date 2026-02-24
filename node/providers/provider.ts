import {
  getProvider as coreGetProvider,
  setMockProvider,
  type Provider,
  type ProviderProfile,
} from "@magenta/core";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { validateInput } from "../tools/helpers.ts";
import { NvimAuthUI } from "../auth/auth-ui.ts";
import * as AnthropicAuthImpl from "../auth/anthropic.ts";

export { setMockProvider };
export * from "./provider-types.ts";

export function getProvider(nvim: Nvim, profile: ProviderProfile): Provider {
  return coreGetProvider(
    nvim.logger,
    new NvimAuthUI(nvim),
    validateInput,
    AnthropicAuthImpl,
    profile,
  );
}
