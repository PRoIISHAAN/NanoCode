// A minimal fine-grained reactive value cell -- the pattern hermes-ink calls "nanostore-style"
// (atom() + useSyncExternalStore), reimplemented from scratch rather than vendored or taken from
// the real `nanostores` package: the whole primitive is small enough that owning it directly avoids
// an external dependency for what amounts to a value box with a change-listener set. See
// decisions/0005-tui-stack.md: reimplement hermes-ink's *patterns*, don't vendor hermes-ink itself
// (whose own atom-like state is deeply coupled to its custom reconciler internals anyway).
//
// The point of a fine-grained atom over a single big `useState` in the root component is that a
// component reading only ONE atom (e.g. just the streaming-text atom) re-renders only when THAT
// atom changes -- not on every event the whole session emits -- which matters under rapid token
// streaming where dozens of updates can arrive per second.
import { useSyncExternalStore } from "react";

export interface Atom<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function atom<T>(initial: T): Atom<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return; // no-op write triggers no re-render
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribes the calling component to `atom`, re-rendering only when its value actually changes. */
export function useAtom<T>(atom: Atom<T>): T {
  return useSyncExternalStore(atom.subscribe, atom.get, atom.get);
}
