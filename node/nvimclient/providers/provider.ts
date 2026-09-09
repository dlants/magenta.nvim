import {
  getProvider as coreGetProvider,
  type Provider,
  type ProviderProfile,
  setMockProvider,
  validateInput,
} from "@magenta/server";
import * as AnthropicAuthImpl from "../auth/anthropic.ts";
import { NvimAuthUI } from "../auth/auth-ui.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";

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
