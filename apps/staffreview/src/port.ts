/**
 * Port selection for the web server, kept in a dependency-free module (no
 * `node:*`/Bun imports) so it can be unit-tested in isolation and shared by the
 * CLI (`cli.ts`) and the server (`server.ts`) without dragging in either.
 *
 * When no port is requested, the server starts at `PORT_RANGE_START` and walks
 * up to the first free port in `[PORT_RANGE_START, PORT_RANGE_END]`. Picking a
 * stable, predictable port (rather than an OS-assigned random one) means the
 * URL is usually the same across runs, while the walk-up keeps it from
 * colliding with another `staff` instance or anything else on that port.
 */
export const PORT_RANGE_START = 4300;
export const PORT_RANGE_END = 4399;

/**
 * Is `e` a "port already bound" error? Bun's bind failure carries
 * `code === "EADDRINUSE"`; the message check is a fallback for other runtimes
 * that surface it only in the text. Both signals are checked (no early return
 * on the code) so a present-but-different `.code` can't mask a matching message.
 */
export function isAddrInUse(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const msg = String((e as Error)?.message ?? "");
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(msg);
}

/**
 * Resolve the requested port. Precedence: the `--port` flag, then the `PORT`
 * environment variable. Returns `undefined` when neither is set, which tells
 * the server to walk its default port range (see `listenOnRange`). An explicit
 * value must be an integer 0–65535 (0 = OS-assigned random port); anything else
 * prints an error and exits.
 */
export function resolvePort(flagVal: string | boolean | undefined): number | undefined {
  const envPort = process.env.PORT?.trim();
  const raw = typeof flagVal === "string" ? flagVal : envPort || undefined;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`\x1b[31merror:\x1b[0m invalid port: ${raw} (expected an integer 0–65535)`);
    process.exit(1);
  }
  return n;
}

/**
 * Bind a server. An explicitly requested port (from `--port`/`$PORT`, including
 * `0` = OS-assigned) is honoured as-is. Otherwise walk the default range and
 * use the first free port, falling back to an OS-assigned port if every port in
 * the range is taken (with a heads-up, since that defeats the predictable URL).
 * `make` is the bind function; it must throw synchronously on an in-use port.
 */
export function listenOnRange<T>(make: (port: number) => T, requested?: number): T {
  if (requested !== undefined) return make(requested);

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      return make(port);
    } catch (e) {
      if (isAddrInUse(e)) continue;
      throw e;
    }
  }
  console.error(
    `\x1b[33mwarning:\x1b[0m ports ${PORT_RANGE_START}-${PORT_RANGE_END} are all in use; using a random port`,
  );
  return make(0);
}
