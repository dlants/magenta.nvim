export type AbsFilePath = string & { __abs_file_path: true };
export type Cwd = AbsFilePath & { __cwd: true };
