# Context

**Objective**: Build a general-purpose system for provisioning isolated development containers for agent work. The system has two layers:

1. **Per-project config** — each project describes its dev environment (container image, workspace path, install command). This lives in the project repo.
2. **Generic orchestration** — scripts that handle the git lifecycle (clone, branch checkout, remote removal) and container lifecycle (start, bind-mount, run install, teardown, fetch branch back). This lives in magenta.

We use magenta.nvim as the first example project, but the orchestration scripts should work with any project that provides the config.

**Lifecycle**:

1. **Provision**: Clone repo locally (`--local` for speed via hardlinks), checkout a branch, remove remote, start the project's dev container with the clone bind-mounted, run the project's install command
2. **Work**: Agent edits, runs tests, makes commits inside the container
3. **Teardown**: Stop container, fetch **only** the named branch back into the host repo (don't trust other refs), clean up temp dir

**Key constraint**: On retrieval, only fetch the named branch — a malicious or confused agent could have tampered with other refs in the clone.

## Per-project config

Each project adds a `container` section to its `.magenta/options.json`:

```jsonc
{
  // ... existing options (commandConfig, etc.) ...
  "container": {
    // Path to a Dockerfile or devcontainer.json (relative to repo root)
    "devcontainer": "docker/Dockerfile",

    // Where to mount the repo inside the container
    "workspacePath": "/workspace",

    // Command to run after the repo is mounted to install dependencies
    "installCommand": "npm ci",

    // Optional: directories to overlay with Docker volumes (e.g. to isolate
    // platform-specific build artifacts when host and container OS differ)
    "volumeOverlays": ["node_modules"],
  },
}
```

The orchestration scripts read `container` from `.magenta/options.json` and use it to drive the container lifecycle. Projects without this section can't use the dev container system.

## Relevant files

- `.github/workflows/test.yml` — CI definition for magenta.nvim; the example Dockerfile should mirror its tooling (Node 24, Neovim, tree-sitter parser, ts-language-server, fzf, fd)
- Provisioning/teardown logic lives in `@magenta/core` as importable modules (using `child_process` for git/docker commands)
- `node/capabilities/docker-shell.ts`, `node/capabilities/docker-file-io.ts` — Docker capability implementations that will use these containers
- `node/environment.ts` — `createDockerEnvironment` factory

## Temp directory layout

```
/tmp/magenta-dev-containers/<container-name>/
  repo/          # the cloned git repo, bind-mounted into the container at <workspacePath>
```

# Implementation

## Step 1: Define per-project config format

- [ ] Add `container` section to `.magenta/options.json` for magenta.nvim:
  - [ ] `devcontainer`: `"docker/Dockerfile"`
  - [ ] `workspacePath`: `"/workspace"`
  - [ ] `installCommand`: `"npm ci"`
  - [ ] `volumeOverlays`: `["node_modules"]`

## Step 2: Example Dockerfile for magenta.nvim

- [ ] Create `docker/Dockerfile`
  - [ ] Base: `node:24-bookworm` (Debian-based, matches CI)
  - [ ] `apt-get install`: `git`, `build-essential`, `fzf`, `fd-find`, `curl`
  - [ ] Install Neovim stable: `curl` the release tarball from GitHub, extract to `/usr/local`
  - [ ] Install `typescript-language-server` and `typescript` globally via `npm install -g`
  - [ ] Build tree-sitter TypeScript parser: `git clone tree-sitter-typescript`, compile with `cc`, copy `.so` to `~/.local/share/nvim/parser/`
  - [ ] Configure git user.name and user.email (so the agent can commit)
  - [ ] Set `WORKDIR /workspace`
  - [ ] Default command: `tail -f /dev/null` (keep container alive)
- [ ] Verify: `docker build -t magenta-dev docker/`

## Step 3: Provisioning module

- [ ] Create `node/core/src/container/provision.ts`
- [ ] `provisionContainer(opts)` function:
  - [ ] Input: `{ repoPath, branch, baseBranch?, containerConfig }`
  - [ ] Generate a unique container name (e.g. `<branch>-<short-hash>`)
  - [ ] Create temp dir at `/tmp/magenta-dev-containers/<name>/repo`
  - [ ] `git clone --local <repo-path> <temp-dir>/repo`
  - [ ] If branch exists: `git checkout <branch>`
  - [ ] If branch doesn't exist: `git checkout -b <branch> <base-branch>` (base-branch defaults to `main`)
  - [ ] `git remote remove origin`
  - [ ] If `devcontainer` points to a Dockerfile: `docker build` (idempotent). If it points to a `devcontainer.json`: use `@devcontainers/cli` or parse the image/Dockerfile from it. For now, just support Dockerfiles.
  - [ ] `docker run -d --name <name> -v <temp-dir>/repo:<workspacePath> [volume overlays] <image>`
  - [ ] `docker exec <name> sh -c 'cd <workspacePath> && <installCommand>'`
  - [ ] Return `{ containerName, tempDir }` for later teardown
- [ ] Write tests (using real Docker, similar to docker-environment.test.ts)

## Step 4: Teardown module

- [ ] Create `node/core/src/container/teardown.ts`
- [ ] `teardownContainer(opts)` function:
  - [ ] Input: `{ containerName, repoPath, branch, tempDir, force? }`
  - [ ] Stop and remove the container: `docker rm -f <containerName>`
  - [ ] Fetch **only** the named branch from the temp clone back into the host repo:
        `git -C <repoPath> fetch <tempDir>/repo <branch>:<branch>`
  - [ ] If the branch already exists and has diverged, only proceed if `force` is true
  - [ ] Clean up volume overlays if any: `docker volume rm` for each
  - [ ] Remove the temp directory: `rm -rf <tempDir>`
- [ ] Write tests (continuation of provision test):
  - [ ] Make a commit inside the container (via `docker exec git commit`)
  - [ ] Call `teardownContainer`, verify:
    - [ ] Container is stopped and removed
    - [ ] Branch was fetched back into the source temp repo with the new commit
    - [ ] Temp directory is cleaned up
    - [ ] Volume overlays are cleaned up
  - [ ] Test force behavior: pre-create a diverged branch in source repo, verify teardown fails without `force` and succeeds with it

## Step 5: Test end-to-end

- [ ] Start a container for magenta.nvim on a test branch
- [ ] `docker exec` to make a commit inside the container
- [ ] Stop the container and verify the commit appears in the host repo on the branch
- [ ] Verify the temp directory and volumes are cleaned up

## Step 6: User command to start a container thread

A `:Magenta docker <branch>` command that provisions a container and creates a thread inside it.

- [ ] Add `docker` to the command list in `lua/magenta/init.lua`
- [ ] Handle `docker <branch>` in `Magenta.command()`:
  - [ ] Read `container` config from `.magenta/options.json`
  - [ ] Run the dev-container provisioning script (clone, checkout branch, start container, install)
  - [ ] Call `createDockerEnvironment` with the container ID
  - [ ] Create a new thread with that environment via `createThreadWithContext`
  - [ ] Switch to the new thread in the sidebar
- [ ] On thread teardown / `:Magenta docker-stop <branch>`:
  - [ ] Run the teardown script (fetch branch back, stop container, clean up)
- [ ] Verify: `:Magenta docker my-feature` opens a thread where the agent can edit files and run tests inside the container

**Future**: Replace this with an orchestration agent that can spawn container threads programmatically via a `spawn_thread` tool.

## Step 7: Documentation

- [ ] Document the `.magenta/options.json` container config format
- [ ] Add usage instructions to the script
- [ ] Update `context.md`
