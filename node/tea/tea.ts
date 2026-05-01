import type { NvimBuffer } from "../nvim/buffer.ts";
import { getCurrentWindow } from "../nvim/nvim.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { Defer } from "../utils/async.ts";
import {
  BINDING_KEYS,
  BINDING_MODES,
  type BindingCtx,
  type BindingKey,
  getBindings,
} from "./bindings.ts";
import {
  d,
  type MountedVDOM,
  type MountedView,
  type MountPoint,
  mountView,
  prettyPrintMountedNode,
  type VDOMNode,
} from "./view.ts";

export type Dispatch<Msg> = (msg: Msg) => void;
export type View<Model> = ({ model }: { model: Model }) => VDOMNode;

type AppState<Model> =
  | {
      status: "running";
      model: Model;
    }
  | {
      status: "error";
      error: string;
    };

export type MountedApp = {
  onKey(key: BindingKey, ctx?: BindingCtx): Promise<void>;
  render(): void;
  unmount(): void;
  getMountedNode(): MountedVDOM;
  waitForRender(): Promise<void>;
  renderVersion: number;
};

export type UnhandledKeyHandler = (args: {
  key: BindingKey;
  buffer: NvimBuffer;
  row: Row0Indexed;
  col: number;
}) => void | Promise<void>;

export type App<Model> = {
  mount(mount: MountPoint): Promise<MountedApp>;
  getState(): AppState<Model>;
  destroy(): void;
};

export function createApp<Model>({
  nvim,
  initialModel,
  View,
  onUnhandledKey,
}: {
  nvim: Nvim;
  initialModel: Model;
  View: View<Model>;
  onUnhandledKey?: UnhandledKeyHandler;
}): App<Model> {
  let currentState: AppState<Model> = {
    status: "running",
    model: initialModel,
  };
  let root: MountedView<{ currentState: AppState<Model> }> | undefined;

  let renderDefer: Defer<void> | undefined;
  let renderPromise: Promise<void> | undefined;
  let pendingRender = false;
  let mountPoint: MountPoint | undefined;
  let renderVersion = 0;

  function render() {
    if (renderPromise) {
      pendingRender = true;
    } else {
      if (!renderDefer) {
        renderDefer = new Defer();
      }

      if (root) {
        renderPromise = (async () => {
          try {
            await root.render({ currentState });
            renderVersion++;
          } catch (err) {
            nvim.logger.error(
              err instanceof Error
                ? `render failed: ${err.message}\n${err.stack}`
                : `render failed: ${JSON.stringify(err)}`,
            );
            if (root) {
              nvim.logger.error(
                `mounted view: ${prettyPrintMountedNode(root._getMountedNode())}`,
              );
            }

            // attempt to recover by re-mounting
            if (mountPoint) {
              try {
                nvim.logger.info("Attempting to recover by re-mounting view");
                await mountPoint.buffer.clearAllExtmarks();
                await mountPoint.buffer.setLines({
                  start: 0 as Row0Indexed,
                  end: -1 as Row0Indexed,
                  lines: [],
                });
                root = await mountView({
                  view: App,
                  mount: mountPoint,
                  props: { currentState },
                });
                renderVersion++;
                nvim.logger.info("Successfully re-mounted view after error");
              } catch (remountErr) {
                nvim.logger.error(
                  remountErr instanceof Error
                    ? `Re-mount failed: ${remountErr.message}\n${remountErr.stack}`
                    : `Re-mount failed: ${JSON.stringify(remountErr)}`,
                );
                if (renderDefer) {
                  renderDefer.reject(err as Error);
                  renderDefer = undefined;
                }
                return;
              }
            } else {
              if (renderDefer) {
                renderDefer.reject(err as Error);
                renderDefer = undefined;
              }
              return;
            }
          }

          renderPromise = undefined;
          if (pendingRender) {
            pendingRender = false;
            render();
          } else {
            if (renderDefer) {
              renderDefer.resolve();
              renderDefer = undefined;
            }
          }
        })();
      }
    }
  }

  function App({ currentState }: { currentState: AppState<Model> }) {
    return d`${
      currentState.status === "running"
        ? View({ model: currentState.model })
        : d`Error: ${currentState.error}`
    }`;
  }

  return {
    async mount(mount: MountPoint) {
      mountPoint = mount;
      root = await mountView({
        view: App,
        mount,
        props: { currentState },
      });

      for (const vimKey of BINDING_KEYS) {
        const modes = BINDING_MODES[vimKey] ?? ["n"];
        for (const mode of modes) {
          try {
            await nvim.call("nvim_exec_lua", [
              `require('magenta').listenToBufKey(${mount.buffer.id}, "${vimKey}", "${mode}")`,
              [],
            ]);
          } catch (e) {
            throw new Error(`failed to nvim_exec_lua: ${JSON.stringify(e)}`);
          }
        }
      }

      return {
        getMountedNode() {
          return root!._getMountedNode();
        },

        unmount() {
          if (root) {
            root.unmount();
            root = undefined;
          }
        },

        render() {
          render();
        },

        async waitForRender() {
          if (renderDefer) {
            await renderDefer.promise;
          }
        },

        get renderVersion() {
          return renderVersion;
        },

        async onKey(key: BindingKey, ctx?: BindingCtx): Promise<void> {
          // Wait for any in-flight render to finish so buffer content
          // and VDOM positions are consistent when we read the cursor.
          if (renderPromise) {
            await renderPromise;
          }
          const window = await getCurrentWindow(mount.nvim);
          const buffer = await window.buffer();
          if (buffer.id !== mount.buffer.id) {
            nvim.logger.warn(
              `Got onKey event ${key}, but current window is not showing mounted buffer`,
            );
            return;
          }
          const { row, col } = await window.getCursor();
          if (root) {
            // win_get_cursor is 1-indexed, while our positions are 0-indexed
            const bindings = getBindings(root._getMountedNode(), {
              row: (row - 1) as Row0Indexed,
              col,
            });

            if (bindings?.[key]) {
              bindings[key](ctx);
            } else if (onUnhandledKey) {
              try {
                await onUnhandledKey({
                  key,
                  buffer: mount.buffer,
                  row: (row - 1) as Row0Indexed,
                  col,
                });
              } catch (err) {
                nvim.logger.error(
                  err instanceof Error
                    ? `onUnhandledKey failed: ${err.message}\n${err.stack}`
                    : `onUnhandledKey failed: ${JSON.stringify(err)}`,
                );
              }
            }
          } else {
            nvim.logger.debug(
              `Got onKey event ${key}, but root is no longer mounted.`,
            );
          }
        },
      };
    },
    getState() {
      return currentState;
    },
    destroy() {
      if (root) {
        root.unmount();
        root = undefined;
      }
      if (mountPoint) {
        mountPoint.buffer.clearAllExtmarks().catch((err) => {
          nvim.logger.error(
            err instanceof Error
              ? `Failed to clear extmarks on destroy: ${err.message}`
              : `Failed to clear extmarks on destroy: ${JSON.stringify(err)}`,
          );
        });
        mountPoint = undefined;
      }
      currentState = {
        status: "error",
        error: "destroyed",
      };
    },
  };
}
