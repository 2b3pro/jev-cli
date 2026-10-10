/** Map concurrently with an ordered, bounded result window, even when the input pauses. */
export async function* orderedMap<T, R>(
  input: Iterable<T> | AsyncIterable<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const source = (async function* () { yield* input; })();
  type Result = { kind: "result"; value: R } | { kind: "error"; error: unknown };
  const pending: Promise<Result>[] = [];
  let reading: Promise<{ kind: "input"; item: IteratorResult<T> }> | undefined;
  let done = false;
  try {
    while (!done || pending.length || reading) {
      if (!done && !reading && pending.length < concurrency) {
        reading = source.next().then((item) => ({ kind: "input" as const, item }));
      }
      const candidates = [reading, pending[0]].filter((p) => p !== undefined);
      if (!candidates.length) break;
      const ready = await Promise.race(candidates);
      if (ready.kind === "input") {
        reading = undefined;
        done = Boolean(ready.item.done);
        if (!ready.item.done) {
          pending.push(Promise.resolve().then(() => map(ready.item.value)).then(
            (value): Result => ({ kind: "result", value }),
            (error): Result => ({ kind: "error", error }),
          ));
        }
      } else {
        pending.shift();
        if (ready.kind === "error") throw ready.error;
        yield ready.value;
      }
    }
  } finally {
    // Observe outstanding reads on early exit; mapped errors are already captured above.
    if (reading) void reading.catch(() => {});
    void source.return(undefined).catch(() => {});
  }
}
