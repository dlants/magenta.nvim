export interface LuaExecutor {
  execLua(code: string): Promise<unknown>;
}
