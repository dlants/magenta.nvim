export type Success<T> = {
  status: "ok";
  value: T;
};

export type ResultError<E> = {
  status: "error";
  error: string;
} & E;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Result<T, E = {}> = Success<T> | ResultError<E>;

export type ExtractSuccess<R extends Result<unknown, unknown>> = Extract<
  R,
  { status: "ok" }
>;

export function extendError<T, E1, E2>(
  result: Result<T, E1>,
  additionalErrorProps: E2,
): Result<T, E1 & E2> {
  if (result.status == "ok") {
    return result;
  }

  return {
    ...result,
    ...additionalErrorProps,
  };
}
