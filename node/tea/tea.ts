import {
  d,
  type MountedVDOM,
  type MountedView,
  type MountPoint,
  mountView,
  type VDOMNode,
} from "./view.ts";
import { BINDING_KEYS, type BindingKey, getBindings } from "./bindings.ts";
import { getCurrentWindow, notifyErr } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { Nvim } from "nvim-node";
import { Defer } from "../utils/async.ts";

export type Dispatch<Msg> = (msg: Msg) => void;

export type Update<Msg, Model, Context = undefined> = Context extends undefined
  ? (msg: Msg, model: Model) => [Model] | [Model, Thunk<Msg> | undefined]
  : (
      msg: Msg,
      model: Model,
      context: Context,
    ) => [Model] | [Model, Thunk<Msg> | undefined];

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
  onKey(key: BindingKey): void;
  render(): void;
  unmount(): void;
  getMountedNode(): MountedVDOM;
  waitForRender(): Promise<void>;
};

export type App<Model> = {
  mount(mount: MountPoint): Promise<MountedApp>;
  getState(): AppState<Model>;
  destroy(): void;
};

export function createApp<Model>({
  nvim,
  initialModel,
  View,
}: {
  nvim: Nvim;
  initialModel: Model;
  View: View<Model>;
}): App<Model> {
  let currentState: AppState<Model> = {
    status: "running",
    model: initialModel,
  };
  let root: MountedView<{ currentState: AppState<Model> }> | undefined;

  let renderDefer: Defer<void> | undefined;
  let renderPromise: Promise<void> | undefined;
  let reRender = false;

  function render() {
    if (renderPromise) {
      reRender = true;
    } else {
      if (!renderDefer) {
        renderDefer = new Defer();
      }

      if (root) {
        renderPromise = root
          .render({ currentState })
          .catch((err) => {
            nvim.logger?.error(err as Error);
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            notifyErr(nvim, err);
            if (renderDefer) {
              renderDefer.reject(err as Error);
              renderDefer = undefined;
            }
          })
          .finally(() => {
            renderPromise = undefined;
            if (reRender) {
              reRender = false;
              nvim.logger?.debug(`followup render triggered`);
              render();
            } else {
              if (renderDefer) {
                renderDefer.resolve();
                renderDefer = undefined;
              }
            }
          });
      }
    }
  }

  function App({ currentState }: { currentState: AppState<Model> }) {
    return d`${
      currentState.status == "running"
        ? View({ model: currentState.model })
        : d`Error: ${currentState.error}`
    }`;
  }

  return {
    async mount(mount: MountPoint) {
      root = await mountView({
        view: App,
        mount,
        props: { currentState },
      });

      for (const vimKey of BINDING_KEYS) {
        try {
          await nvim.call("nvim_exec_lua", [
            `require('magenta').listenToBufKey(${mount.buffer.id}, "${vimKey}")`,
            [],
          ]);
        } catch (e) {
          throw new Error(`failed to nvim_exec_lua: ${JSON.stringify(e)}`);
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

        async onKey(key: BindingKey) {
          const window = await getCurrentWindow(mount.nvim);
          const buffer = await window.buffer();
          if (buffer.id != mount.buffer.id) {
            nvim.logger?.warn(
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
            if (bindings && bindings[key]) {
              bindings[key]();
            }
          } else {
            nvim.logger?.debug(
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
      currentState = {
        status: "error",
        error: "destroyed",
      };
    },
  };
}

export type Thunk<Msg> = (dispatch: Dispatch<Msg>) => Promise<void>;

export function wrapThunk<MsgType extends string, InnerMsg>(
  msgType: MsgType,
  thunk: Thunk<InnerMsg> | undefined,
): Thunk<{ type: MsgType; msg: InnerMsg }> | undefined {
  if (!thunk) {
    return undefined;
  }
  return (dispatch: Dispatch<{ type: MsgType; msg: InnerMsg }>) =>
    thunk((msg: InnerMsg) => dispatch({ type: msgType, msg }));
}

export function chainThunks<Msg>(
  ...thunks: (Thunk<Msg> | undefined)[]
): Thunk<Msg> {
  return async (dispatch) => {
    for (const thunk of thunks) {
      if (thunk) {
        await thunk(dispatch);
      }
    }
  };
}

export function parallelThunks<Msg>(
  ...thunks: (Thunk<Msg> | undefined)[]
): Thunk<Msg> {
  return async (dispatch) => {
    await Promise.all(thunks.map((t) => t && t(dispatch)));
  };
}
