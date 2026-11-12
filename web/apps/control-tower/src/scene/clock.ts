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
