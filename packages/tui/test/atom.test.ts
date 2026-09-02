import { describe, expect, it, vi } from "vitest";
import { atom } from "../src/atom.ts";

describe("atom", () => {
  it("get() returns the current value and set() updates it", () => {
    const a = atom(1);
    expect(a.get()).toBe(1);
    a.set(2);
    expect(a.get()).toBe(2);
  });

  it("notifies subscribers when the value changes", () => {
    const a = atom("x");
    const listener = vi.fn();
    a.subscribe(listener);
    a.set("y");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify subscribers for a no-op write (same value)", () => {
    const a = atom(5);
    const listener = vi.fn();
    a.subscribe(listener);
    a.set(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const a = atom(0);
    const listener = vi.fn();
    const unsubscribe = a.subscribe(listener);
    unsubscribe();
    a.set(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
