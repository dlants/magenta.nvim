# Overview

this is a neovim plugin for agentic tool use
the entrypoint is in `lua/magenta/init.lua`. When the plugin starts up, it will kick off the `node/magenta.ts` node process. That will reach back out and establish the bridge, which will grab the options from lua and establish bidirectional communication between the two halves of the plugin.

options are configured in `lua/magenta/options.lua`

# Testing

to run the full test suite, use `npx vitest run`
to run a specific test file, use `npx vitest run <file>`
tests should make use of the `node/test/preamble.ts` helpers.
when doing integration-level testing, like user flows, use the `withDriver` helper and the interactions in `node/test/driver.ts`. When performing generic user actions that may be reusable between tests, put them into the NvimDriver class as helpers.

# Notes

To avoid complexity, keep variable names on the lua side camelCase, to match the variables defined in typescript.
