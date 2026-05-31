import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import {
  resolvePort,
  listenOnRange,
  isAddrInUse,
  PORT_RANGE_START,
  PORT_RANGE_END,
} from "./port.ts";

// The shape Bun.serve throws on a taken port: an Error with code "EADDRINUSE".
const inUse = (port: number) =>
  Object.assign(new Error(`Failed to start server. Is port ${port} in use?`), {
    code: "EADDRINUSE",
  });

describe("listenOnRange", () => {
  test("honours an explicit port without walking", () => {
    const tried: number[] = [];
    const got = listenOnRange((p) => {
      tried.push(p);
      return `srv:${p}`;
    }, 8080);
    expect(got).toBe("srv:8080");
    expect(tried).toEqual([8080]);
  });

  test("honours an explicit 0 (OS-assigned) without walking the range", () => {
    const tried: number[] = [];
    listenOnRange((p) => {
      tried.push(p);
      return p;
    }, 0);
    expect(tried).toEqual([0]);
  });

  test("with no port requested, starts at PORT_RANGE_START", () => {
    expect(listenOnRange((p) => `srv:${p}`)).toBe(`srv:${PORT_RANGE_START}`);
  });

  test("walks up past in-use ports to the first free one", () => {
    const firstFree = PORT_RANGE_START + 3; // 4300/4301/4302 busy, 4303 free
    const tried: number[] = [];
    const got = listenOnRange((p) => {
      tried.push(p);
      if (p < firstFree) throw inUse(p);
      return `srv:${p}`;
    });
    expect(got).toBe(`srv:${firstFree}`);
    expect(tried).toEqual([
      PORT_RANGE_START,
      PORT_RANGE_START + 1,
      PORT_RANGE_START + 2,
      firstFree,
    ]);
  });

  test("falls back to an OS-assigned port (0) with a warning when the whole range is busy", () => {
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      const tried: number[] = [];
      const got = listenOnRange((p) => {
        tried.push(p);
        if (p !== 0) throw inUse(p);
        return "srv:0";
      });
      expect(got).toBe("srv:0");
      // every port in [start, end], then a final 0
      expect(tried.length).toBe(PORT_RANGE_END - PORT_RANGE_START + 2);
      expect(tried.at(-1)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/all in use/);
    } finally {
      warn.mockRestore();
    }
  });

  test("re-throws a non-address-in-use error instead of walking", () => {
    const tried: number[] = [];
    expect(() =>
      listenOnRange((p) => {
        tried.push(p);
        throw new Error("permission denied");
      }),
    ).toThrow("permission denied");
    expect(tried).toEqual([PORT_RANGE_START]); // stopped on the first failure
  });
});

describe("isAddrInUse", () => {
  test("true for Bun's EADDRINUSE error (via .code)", () => {
    expect(isAddrInUse(inUse(4300))).toBe(true);
  });

  test("true for a code-less 'address already in use' message", () => {
    expect(
      isAddrInUse(new Error("listen EADDRINUSE: address already in use 0.0.0.0:4300")),
    ).toBe(true);
  });

  test("false for unrelated errors and non-errors", () => {
    expect(isAddrInUse(new Error("permission denied"))).toBe(false);
    expect(isAddrInUse(null)).toBe(false);
    expect(isAddrInUse(undefined)).toBe(false);
    expect(isAddrInUse("nope")).toBe(false);
  });
});

describe("resolvePort", () => {
  const original = process.env.PORT;
  beforeEach(() => {
    delete process.env.PORT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PORT;
    else process.env.PORT = original;
  });

  test("undefined when neither --port nor $PORT is set (→ walk the range)", () => {
    expect(resolvePort(undefined)).toBeUndefined();
    expect(resolvePort(true)).toBeUndefined(); // bare `--port`, no value, no env
  });

  test("--port flag wins and parses", () => {
    expect(resolvePort("8080")).toBe(8080);
  });

  test("$PORT is used when there is no flag", () => {
    process.env.PORT = "5000";
    expect(resolvePort(undefined)).toBe(5000);
    expect(resolvePort(true)).toBe(5000); // bare flag falls back to env
  });

  test("--port overrides $PORT", () => {
    process.env.PORT = "5000";
    expect(resolvePort("8080")).toBe(8080);
  });

  test("blank/whitespace $PORT is treated as unset", () => {
    process.env.PORT = "   ";
    expect(resolvePort(undefined)).toBeUndefined();
    process.env.PORT = "";
    expect(resolvePort(undefined)).toBeUndefined();
  });

  test("explicit 0 is valid (OS-assigned random port)", () => {
    expect(resolvePort("0")).toBe(0);
  });
});
