import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/* `findBy*` and `waitFor` give up after 1s by default, which measures the
 * machine more than the app: under a full monorepo run — several vitest pools,
 * often beside a sibling worktree's suite — a render that takes 200ms idle can
 * miss that window, and the suite reports "unable to find" for an element that
 * arrived moments later. */
configure({ asyncUtilTimeout: 5000 });

/* React Aria's selection indicator (the sliding tab pill) asks the element for
 * its running animations, and its tab list builds selectors with CSS.escape.
 * jsdom has neither. */
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}
if (typeof globalThis.CSS === "undefined") {
  Object.defineProperty(globalThis, "CSS", { value: {}, configurable: true });
}
if (typeof globalThis.CSS.escape !== "function") {
  globalThis.CSS.escape = (value: string) => value.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (char) => `\\${char}`);
}

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

if (typeof localStorage === "undefined" || typeof localStorage.clear !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
  });
}

/* The Todos board mirrors its filter set to localStorage so a filtered view
 * survives a new tab. That is real browser state, so it must not leak from one
 * case into the next: every test starts with empty storage. Tests that need a
 * stored value seed it in their own beforeEach, which runs after this one. */
beforeEach(() => {
  localStorage.clear();
});

/* @xyflow/react (the org map) needs DOM measurement APIs
 * jsdom doesn't implement. Standard mocks from the xyflow testing guide,
 * defined only when missing so tests that stub their own (e.g. the captured
 * ResizeObserver in use-stick-to-bottom.dom.test) keep full control. */
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverMock {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

if (typeof (globalThis as Record<string, unknown>).DOMMatrixReadOnly === "undefined") {
  class DOMMatrixReadOnlyMock {
    readonly m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? +scale : 1;
    }
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyMock;
}

/* @radix-ui/react-focus-scope (Dialog, Popover, AlertDialog, Select, Dropdown)
 * defers its unmount work to a `setTimeout(…, 0)`: the AUTOFOCUS_ON_UNMOUNT
 * dispatch and the refocus of whatever was focused before the scope opened.
 * That is a real Node timer, so it outlives the jsdom environment the test ran
 * in. Vitest recreates the jsdom global for the next file in the same worker
 * process, so if the timer is still pending at the file boundary its callback
 * runs against the *next* file's realm: `new CustomEvent(...)` resolves to the
 * new window's constructor while `container` is an element from the old
 * document, and jsdom's dispatchEvent rejects the cross-realm Event. The throw
 * is reported against whichever file happened to be running and fails a run
 * whose every test passed.
 *
 * Unmounting here and giving the timer one turn of the event loop lets it fire
 * while this file's realm is still installed. Cleanup is called explicitly
 * rather than left to Testing Library's own afterEach, because the order
 * between the two hooks is not guaranteed — whichever runs first, the unmount
 * happens before the flush below.
 */
afterEach(async () => {
  cleanup();
  if (vi.isFakeTimers()) {
    /* A test left fake timers installed. The Radix unmount timer is then a
     * fake timer that would never fire, so drop it with the fake clock instead
     * of leaking it — and restore real timers so the await below cannot hang. */
    vi.useRealTimers();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
});
