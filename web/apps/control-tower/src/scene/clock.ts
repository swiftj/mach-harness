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
  /**
   * Call back once after `ms` (no frame asked for in between), with the clock's time then. A store
   * with nothing moving waits with this instead of asking for 60 frames a second (R7). Optional: a
   * clock without it is asked for frames as before.
   */
  later?(callback: (now: number) => void, ms: number): number;
  cancelLater?(handle: number): void;
}

/** The browser's clock: performance.now and requestAnimationFrame. */
export function browserClock(): Clock {
  return {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
    later: (callback, ms) => window.setTimeout(() => callback(performance.now()), Math.max(0, ms)),
    cancelLater: (handle) => window.clearTimeout(handle),
  };
}

export interface ManualClock extends Clock {
  /** Move wall time on by `ms`, run the waits that fell due, then the frames that were asked for, once. */
  advance(ms: number): void;
  /** Run `count` frames of `ms` each. */
  frames(count: number, ms?: number): void;
  /** Frames and waits asked for and not yet run. */
  readonly pending: number;
  /** Frames asked for and not yet run (waits not counted). */
  readonly pendingFrames: number;
  /** Frames run so far. */
  readonly framesRun: number;
}

/** A clock that moves only when told to. */
export function manualClock(start = 0): ManualClock {
  let now = start;
  let nextHandle = 1;
  let framesRun = 0;
  let queue = new Map<number, (now: number) => void>();
  const waits = new Map<number, { due: number; callback: (now: number) => void }>();
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
    later(callback, ms) {
      const handle = nextHandle++;
      waits.set(handle, { due: now + Math.max(0, ms), callback });
      return handle;
    },
    cancelLater(handle) {
      waits.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (const [handle, w] of [...waits]) {
        if (w.due > now) continue;
        waits.delete(handle);
        w.callback(now);
      }
      const due = queue;
      queue = new Map();
      framesRun += due.size;
      for (const callback of due.values()) callback(now);
    },
    frames(count, ms = 1000 / 60) {
      for (let i = 0; i < count; i++) clock.advance(ms);
    },
    get pending() {
      return queue.size + waits.size;
    },
    get pendingFrames() {
      return queue.size;
    },
    get framesRun() {
      return framesRun;
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
  const waits = new Map<number, { due: number; callback: (now: number) => void; baseHandle: number | null }>();
  const clock: SwitchableClock = {
    get mode() {
      return mode;
    },
    later(callback, ms) {
      const handle = nextHandle++;
      const w = { due: clock.now() + Math.max(0, ms), callback, baseHandle: null as number | null };
      waits.set(handle, w);
      if (mode === "live") {
        w.baseHandle = base.later
          ? base.later(() => {
              waits.delete(handle);
              callback(clock.now());
            }, ms)
          : base.request(() => {
              waits.delete(handle);
              callback(clock.now());
            });
      }
      return handle;
    },
    cancelLater(handle) {
      const w = waits.get(handle);
      if (!w) return;
      waits.delete(handle);
      if (w.baseHandle !== null) (base.cancelLater ?? base.cancel)(w.baseHandle);
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
      // Waits now fall due on manual time.
      for (const w of waits.values()) {
        if (w.baseHandle !== null) (base.cancelLater ?? base.cancel)(w.baseHandle);
        w.baseHandle = null;
      }
    },
    live() {
      if (mode === "live") return;
      offset = manualNow - base.now();
      mode = "live";
      arm();
      // Waits made or held in manual time go back to the base clock for what is left of them.
      for (const [handle, w] of waits) {
        if (w.baseHandle !== null) continue;
        const run = () => {
          waits.delete(handle);
          w.callback(clock.now());
        };
        w.baseHandle = base.later ? base.later(run, Math.max(0, w.due - clock.now())) : base.request(run);
      }
    },
    advance(ms, frameMs = 250) {
      if (mode !== "manual") throw new Error("advance() needs the manual clock: call manual() first.");
      if (!(ms >= 0) || !(frameMs > 0)) throw new Error("advance(ms, frameMs): ms >= 0 and frameMs > 0.");
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(frameMs, remaining);
        manualNow += step;
        remaining -= step;
        for (const [handle, w] of [...waits]) {
          if (w.due > manualNow || w.baseHandle !== null) continue;
          waits.delete(handle);
          w.callback(manualNow);
        }
        flush(manualNow);
      }
    },
  };
  return clock;
}
