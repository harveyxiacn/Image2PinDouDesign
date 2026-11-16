import { describe, expect, it } from "vitest";
import { createHashGuard } from "../components/pattern/useLeaveGuard";

function env(start: string, answer: boolean) {
  const s = { hash: start, asked: 0, e: null as never as { hash: () => string; setHash: (h: string) => void; confirm: (m: string) => boolean } };
  s.e = { hash: () => s.hash, setHash: (h) => { s.hash = h; }, confirm: () => { s.asked++; return answer; } };
  return s;
}

describe("createHashGuard", () => {
  it("cancel restores the previous hash and does not prompt again for the restore event", () => {
    const s = env("#/add?mode=batch", false);
    const g = createHashGuard(s.e);
    s.hash = "#/gallery";
    expect(g.onChange()).toBe(false);
    expect(s.hash).toBe("#/add?mode=batch");
    expect(g.onChange()).toBe(true); // restore's own hashchange
    expect(s.asked).toBe(1);
  });
  it("accept lets navigation through and remembers the new hash", () => {
    const s = env("#/add", true);
    const g = createHashGuard(s.e);
    s.hash = "#/gallery";
    expect(g.onChange()).toBe(true);
    expect(s.hash).toBe("#/gallery");
    expect(g.onChange()).toBe(true); // same hash: no prompt
    expect(s.asked).toBe(1);
  });
  it("after a cancelled move a second attempt prompts again", () => {
    const s = env("#/add", false);
    const g = createHashGuard(s.e);
    s.hash = "#/x"; g.onChange(); g.onChange();
    s.hash = "#/y"; expect(g.onChange()).toBe(false);
    expect(s.asked).toBe(2);
  });
});
