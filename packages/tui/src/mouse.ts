import { PassThrough } from "node:stream";

// Real, reported gap: nanocode's fullscreen mode (packages/cli/src/tui.tsx's alternate-screen-
// buffer entry) never captured scroll-wheel input at all, so a user's own instinct to scroll up and
// re-read older, clipped transcript content just triggered the TERMINAL's own default scroll
// behavior instead -- which does effectively nothing useful inside the alternate screen buffer
// (it has no scrollback of its own, by design; see transcript.tsx's own header comment). Real
// fullscreen terminal apps (vim/less/htop, and per the user's own explicit ask, Claude Code) instead
// enable xterm's SGR mouse reporting so wheel events arrive as parseable escape sequences the app
// reads and acts on itself, exactly like an arrow-key or Page Up/Down press.
//
// The wheel events this module detects are handed off through a tiny module-level pub-sub (`onWheel`)
// rather than threaded through Ink's own `useInput`/atom props, because the thing producing them
// (`wrapStdinForMouse`, called once in packages/cli/src/tui.tsx before Ink ever mounts) lives
// entirely outside React -- there is no component tree yet at the point a wheel byte sequence needs
// somewhere to go.
export type WheelDirection = "up" | "down";

const listeners = new Set<(direction: WheelDirection) => void>();

/** Subscribes to wheel-scroll events; returns an unsubscribe function, the same shape every other
 * subscription in this codebase (Session.subscribe, the backpressure queue) already uses. */
export function onWheel(listener: (direction: WheelDirection) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitWheel(direction: WheelDirection): void {
  for (const listener of listeners) listener(direction);
}

/** Enables xterm mouse + SGR extended-coordinate reporting -- write this to stdout once, right after
 * entering the alternate screen buffer. SGR mode (`?1006`) is requested alongside basic button-event
 * tracking (`?1000`) so wheel reports arrive in the unambiguous `ESC [ < Cb ; Cx ; Cy M` form
 * `wrapStdinForMouse` below parses, rather than the older X10 form (which encodes coordinates as raw
 * bytes and silently corrupts past column/row 223). */
export const MOUSE_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1006h";

/** Reverses `MOUSE_ENABLE_SEQUENCE` -- write this before (or as part of) leaving the alternate screen
 * buffer, or the user's terminal keeps intercepting scroll/clicks for mouse reporting after nanocode
 * exits, breaking normal text selection and native scrollback in their shell. */
export const MOUSE_DISABLE_SEQUENCE = "\x1b[?1006l\x1b[?1000l";

// `Cb` (the first parameter) for a wheel report: xterm ORs the base button code with 64 for any
// wheel motion, then the low bit distinguishes the direction -- 64 (0b1000000) is wheel-up, 65
// (0b1000001) is wheel-down. Modifier keys (shift/meta/ctrl) add further bits on top (4/8/16) that
// this feature has no use for and ignores by only inspecting bit 0.
const WHEEL_BASE_BIT = 64;

// Matches one SGR mouse report: `ESC [ < Cb ; Cx ; Cy (M|m)` -- 'M' for a press-type report (every
// wheel motion; wheel has no real "release"), 'm' for a genuine button release. Global (`g`) so a
// single chunk containing several coalesced reports (a fast scroll burst) strips all of them in one
// pass via `String.replace`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC byte is the literal, required first byte of a real SGR mouse report -- there's no other way to match one.
const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

/** A minimal subset of `NodeJS.ReadStream` that Ink's `App` component actually calls (confirmed by
 * reading ink/build/components/App.js directly) -- `wrapStdinForMouse` only needs to satisfy this
 * much, not the full stream interface. */
export interface MouseAwareStdin {
  isTTY: boolean;
  setRawMode(mode: boolean): void;
  ref(): void;
  unref(): void;
  setEncoding(encoding: BufferEncoding): void;
  read(): Buffer | string | null;
  on(event: "readable" | "end" | "error", listener: (...args: never[]) => void): void;
  addListener(event: "readable" | "end" | "error", listener: (...args: never[]) => void): void;
  removeListener(event: "readable" | "end" | "error", listener: (...args: never[]) => void): void;
}

/** Wraps a real TTY stdin so mouse-wheel byte sequences are intercepted and turned into `onWheel`
 * events instead of ever reaching Ink's own keypress parser (which has no idea what to do with raw
 * SGR mouse bytes -- passing them through untouched risks them being misread as garbled keystrokes).
 * Implemented as a real `PassThrough` handed to Ink as ITS `stdin` (rather than monkey-patching
 * `process.stdin` in place) so Ink's own `setRawMode`/`ref`/`unref`/`read()` calls keep working
 * exactly as they would against the real stream -- this proxy just delegates each one through,
 * except for the byte content itself, which it filters first.
 *
 * Accepted, narrow gap: a single mouse report split exactly across two separate `data` chunks (rare
 * for local terminal input, which the OS/pty typically delivers as one atomic write) would leave an
 * unstripped fragment for Ink to see -- harmless, since an unrecognized partial escape sequence is
 * silently ignored the same way any other unknown one already is. */
export function wrapStdinForMouse(realStdin: NodeJS.ReadStream): MouseAwareStdin {
  const proxy = new PassThrough();

  realStdin.on("data", (chunk: Buffer) => {
    // Latin1 is a lossless 1:1 byte<->codepoint mapping -- round-tripping through it (decode, regex
    // over the ASCII-only escape/digit bytes, re-encode) preserves arbitrary input byte-for-byte
    // (multi-byte UTF-8 paste content included) except for the mouse sequences actually matched and
    // stripped.
    const text = chunk.toString("latin1");
    const cleaned = text.replace(SGR_MOUSE_PATTERN, (_match, cb: string) => {
      const code = Number(cb);
      if ((code & WHEEL_BASE_BIT) === WHEEL_BASE_BIT) {
        emitWheel((code & 1) === 1 ? "down" : "up");
      }
      return "";
    });
    if (cleaned.length > 0) proxy.push(Buffer.from(cleaned, "latin1"));
  });
  realStdin.on("end", () => proxy.push(null));

  return Object.assign(proxy, {
    isTTY: realStdin.isTTY,
    setRawMode: (mode: boolean) => realStdin.setRawMode?.(mode),
    ref: () => realStdin.ref(),
    unref: () => realStdin.unref(),
  }) as unknown as MouseAwareStdin;
}
