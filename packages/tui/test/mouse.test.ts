import { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOUSE_DISABLE_SEQUENCE,
  MOUSE_ENABLE_SEQUENCE,
  type MouseAwareStdin,
  onWheel,
  type WheelDirection,
  wrapStdinForMouse,
} from "../src/mouse.ts";

/** A minimal `NodeJS.ReadStream`-like fake: a real `node:events` `EventEmitter` (so `.on("data", ...)`
 * / `.on("end", ...)` -- the only two events `wrapStdinForMouse` actually listens for -- work exactly
 * like they would against a real stream), plus the handful of extra properties/methods
 * `wrapStdinForMouse` reads or delegates through (`isTTY`, `setRawMode`, `ref`, `unref`) as `vi.fn()`
 * spies so calls through the returned proxy can be asserted directly. */
function createFakeStdin() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
}

/** Feeds one chunk of raw bytes into a fake stdin created by `createFakeStdin`, exactly the way a
 * real TTY delivers a `"data"` event. */
function feed(fakeStdin: EventEmitter, text: string): void {
  fakeStdin.emit("data", Buffer.from(text, "latin1"));
}

/** Reads whatever the proxy's `PassThrough` has buffered since the last read, as a plain string --
 * `undefined` (rather than `null`) when nothing was pushed at all (e.g. a chunk that was pure mouse
 * bytes with nothing left over to forward). */
function readForwarded(proxy: ReturnType<typeof wrapStdinForMouse>): string | undefined {
  const chunk = proxy.read();
  if (chunk === null || chunk === undefined) return undefined;
  return Buffer.isBuffer(chunk) ? chunk.toString("latin1") : chunk;
}

// `onWheel` has no public "emit" export of its own (see mouse.ts's own header comment on why: the
// only real producer, `wrapStdinForMouse`, lives entirely outside React) -- so every test below
// drives a real wheel event the same way production code does, through `wrapStdinForMouse` parsing
// an actual SGR byte sequence, rather than reaching into module internals.
describe("onWheel", () => {
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    // The `listeners` set backing `onWheel` is module-level state shared across every test in this
    // file -- without this, a listener left subscribed by one test would still fire (and could
    // throw, if it were a `vi.fn` a later test asserts a specific call count on) in a later, wholly
    // unrelated test.
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  });

  it("subscribing returns an unsubscribe function, and multiple listeners all fire for the same event", () => {
    const first = vi.fn();
    const second = vi.fn();
    unsubscribes.push(onWheel(first), onWheel(second));

    const fakeStdin = createFakeStdin();
    wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
    feed(fakeStdin, "\x1b[<64;10;10M");

    expect(first).toHaveBeenCalledExactlyOnceWith("up");
    expect(second).toHaveBeenCalledExactlyOnceWith("up");
  });

  it("unsubscribing stops a listener from firing on a later wheel event", () => {
    const listener = vi.fn();
    const unsubscribe = onWheel(listener);

    const fakeStdin = createFakeStdin();
    wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
    feed(fakeStdin, "\x1b[<64;10;10M");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    feed(fakeStdin, "\x1b[<65;10;10M");
    expect(listener).toHaveBeenCalledTimes(1); // still just the one call from before unsubscribing
  });

  it("emitting with no listeners registered at all doesn't throw", () => {
    const fakeStdin = createFakeStdin();
    expect(() => {
      wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "\x1b[<64;10;10M");
    }).not.toThrow();
  });
});

describe("wrapStdinForMouse", () => {
  it("fires onWheel with 'up' for a real SGR wheel-up sequence (Cb=64)", () => {
    const directions: WheelDirection[] = [];
    const unsubscribe = onWheel((direction) => directions.push(direction));
    try {
      const fakeStdin = createFakeStdin();
      wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "\x1b[<64;10;10M");
      expect(directions).toEqual(["up"]);
    } finally {
      unsubscribe();
    }
  });

  it("fires onWheel with 'down' for a real SGR wheel-down sequence (Cb=65)", () => {
    const directions: WheelDirection[] = [];
    const unsubscribe = onWheel((direction) => directions.push(direction));
    try {
      const fakeStdin = createFakeStdin();
      wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "\x1b[<65;10;10M");
      expect(directions).toEqual(["down"]);
    } finally {
      unsubscribe();
    }
  });

  it("strips a wheel sequence mixed in with real keystrokes, firing onWheel AND forwarding the surrounding bytes unmangled", () => {
    const directions: WheelDirection[] = [];
    const unsubscribe = onWheel((direction) => directions.push(direction));
    try {
      const fakeStdin = createFakeStdin();
      const proxy = wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "a\x1b[<64;5;5Mb");

      expect(directions).toEqual(["up"]);
      const forwarded = readForwarded(proxy) ?? "";
      expect(forwarded).toContain("a");
      expect(forwarded).toContain("b");
      expect(forwarded).not.toContain("\x1b[<64;5;5M");
      expect(forwarded).not.toContain("\x1b"); // no raw escape byte survives at all
    } finally {
      unsubscribe();
    }
  });

  it("strips a non-wheel mouse report (a plain click/release, Cb without bit 64 set) but does NOT fire onWheel for it", () => {
    const directions: WheelDirection[] = [];
    const unsubscribe = onWheel((direction) => directions.push(direction));
    try {
      const fakeStdin = createFakeStdin();
      const proxy = wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "before\x1b[<0;5;5Mafter");

      expect(directions).toEqual([]); // a plain button press is not a wheel motion
      const forwarded = readForwarded(proxy) ?? "";
      expect(forwarded).toBe("beforeafter"); // the report itself is still stripped
    } finally {
      unsubscribe();
    }
  });

  it("fires onWheel once per sequence, in order, for multiple coalesced reports in a single chunk", () => {
    const directions: WheelDirection[] = [];
    const unsubscribe = onWheel((direction) => directions.push(direction));
    try {
      const fakeStdin = createFakeStdin();
      wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M");

      expect(directions).toEqual(["up", "up", "down"]);
    } finally {
      unsubscribe();
    }
  });

  it("a chunk with no mouse sequence at all passes through completely untouched", () => {
    const directions: WheelDirection[] = [];
    const unsubscribe = onWheel((direction) => directions.push(direction));
    try {
      const fakeStdin = createFakeStdin();
      const proxy = wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);
      feed(fakeStdin, "just typing normally");

      expect(directions).toEqual([]);
      expect(readForwarded(proxy)).toBe("just typing normally");
    } finally {
      unsubscribe();
    }
  });

  it("forwards isTTY from the underlying stream, and delegates setRawMode/ref/unref calls through to it", () => {
    const fakeStdin = createFakeStdin();
    const proxy = wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream);

    expect(proxy.isTTY).toBe(true);

    proxy.setRawMode(true);
    expect(fakeStdin.setRawMode).toHaveBeenCalledExactlyOnceWith(true);

    proxy.ref();
    expect(fakeStdin.ref).toHaveBeenCalledOnce();

    proxy.unref();
    expect(fakeStdin.unref).toHaveBeenCalledOnce();
  });

  it("pushes null onto the proxy once the underlying stream ends", async () => {
    const fakeStdin = createFakeStdin();
    const proxy = wrapStdinForMouse(fakeStdin as unknown as NodeJS.ReadStream) as MouseAwareStdin &
      PassThrough;

    // `.resume()` puts the (otherwise paused, since nothing else here attaches a "data" listener)
    // proxy into flowing mode -- required for a `push(null)` EOF signal to actually settle into
    // `readableEnded` promptly, rather than sitting unconsumed in the stream's internal state.
    proxy.resume();
    fakeStdin.emit("end");
    await new Promise((resolve) => proxy.on("end", resolve));

    expect(proxy.readableEnded).toBe(true);
  });
});

describe("MOUSE_ENABLE_SEQUENCE / MOUSE_DISABLE_SEQUENCE", () => {
  it("are exactly the expected xterm SGR mouse-reporting escape sequences", () => {
    // Locked in verbatim: tui.tsx writes these bytes directly to stdout, so a change here (even
    // reordering the two `?1000`/`?1006` sub-sequences) would need to stay a deliberate, reviewed
    // decision, not an accidental refactor.
    expect(MOUSE_ENABLE_SEQUENCE).toBe("\x1b[?1000h\x1b[?1006h");
    expect(MOUSE_DISABLE_SEQUENCE).toBe("\x1b[?1006l\x1b[?1000l");
  });
});
