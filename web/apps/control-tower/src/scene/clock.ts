/**
 * The playback clock's source of wall time and frames. Injectable, so tests and the capture script
 * drive time by hand and get the same frames every run.
 */
export interface Clock {
  /** Wall time in milliseconds (monotonic). */
  now(): number;
  /** Ask for one frame; the callback gets the frame's wall time. */
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

/** The browser's clock: performance.now and requestAnimationFrame. */
export function browserClock(): Clock {
  return {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

export interface ManualClock extends Clock {
  /** Move wall time on by `ms` and run the frames that were asked for, once. */
  advance(ms: number): void;
  /** Run `count` frames of `ms` each. */
  frames(count: number, ms?: number): void;
  readonly pending: number;
}

/** A clock that moves only when told to. */
export function manualClock(start = 0): ManualClock {
  let now = start;
  let nextHandle = 1;
  let queue = new Map<number, (now: number) => void>();
  const clock: ManualClock = {
    now: () => now,
    request(callback) {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      queue.delete(handle);
    },
    advance(ms) {
      now += ms;
      const due = queue;
      queue = new Map();
      for (const callback of due.values()) callback(now);
    },
    frames(count, ms = 1000 / 60) {
      for (let i = 0; i < count; i++) clock.advance(ms);
    },
    get pending() {
      return queue.size;
    },
  };
  return clock;
}

export interface SwitchableClock extends Clock {
  /** "live": frames come from the base clock. "manual": time moves only through advance(). */
  readonly mode: "live" | "manual";
  /** Stop taking frames from the base clock; time stands still until advance(). */
  manual(): void;
  /** Go back to the base clock; time continues from where manual time left it. */
  live(): void;
  /**
   * Manual mode only: move time on by exactly `ms`, delivering frames of at most `frameMs`
   * (default 250, the store's largest frame) so a recording can be rendered frame by frame.
   */
  advance(ms: number, frameMs?: number): void;
}

/**
 * A clock that runs on a base clock (the browser's) until switched to manual, for the capture
 * script. Time is continuous across switches. Only development and capture builds use it.
 */
export function switchableClock(base: Clock): SwitchableClock {
  let mode: "live" | "manual" = "live";
  let offset = 0;
  let manualNow = 0;
  let nextHandle = 1;
  const queue = new Map<number, (now: number) => void>();
  let baseHandle: number | null = null;
  const flush = (now: number): void => {
    const due = [...queue.values()];
    queue.clear();
    for (const callback of due) callback(now);
  };
  const arm = (): void => {
    if (mode !== "live" || baseHandle !== null || queue.size === 0) return;
    baseHandle = base.request((baseNow) => {
      baseHandle = null;
      flush(baseNow + offset);
    });
  };
  const disarm = (): void => {
    if (baseHandle !== null) base.cancel(baseHandle);
    baseHandle = null;
  };
  const clock: SwitchableClock = {
    get mode() {
      return mode;
    },
    now: () => (mode === "manual" ? manualNow : base.now() + offset),
    request(callback) {
      const handle = nextHandle++;
      queue.set(handle, callback);
      arm();
      return handle;
    },
    cancel(handle) {
      queue.delete(handle);
      if (queue.size === 0) disarm();
    },
    manual() {
      if (mode === "manual") return;
      manualNow = clock.now();
      mode = "manual";
      disarm();
    },
    live() {
      if (mode === "live") return;
      offset = manualNow - base.now();
      mode = "live";
      arm();
    },
    advance(ms, frameMs = 250) {
      if (mode !== "manual") throw new Error("advance() needs the manual clock: call manual() first.");
      if (!(ms >= 0) || !(frameMs > 0)) throw new Error("advance(ms, frameMs): ms >= 0 and frameMs > 0.");
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(frameMs, remaining);
        manualNow += step;
        remaining -= step;
        flush(manualNow);
      }
    },
  };
  return clock;
}
