/**
 * Development only: a frame-time meter. It measures requestAnimationFrame intervals (the browser's
 * real frame pacing, which includes React's commits and the SVG's paint) over the last 240 frames,
 * and exposes the numbers on `window.__atlasPerf` for the capture script. Never in a production build.
 */
import { useEffect, useRef, useState } from "react";

export interface AtlasPerf {
  frames: number[];
  reset(): void;
  stats(): { n: number; mean: number; p50: number; p95: number; p99: number; max: number; over20: number };
}

export function Meter() {
  const [text, setText] = useState("");
  const ref = useRef<number[]>([]);
  useEffect(() => {
    const frames = ref.current;
    let last = performance.now();
    let raf = 0;
    let shown = last;
    const stats = (list: number[]) => {
      const s = [...list].sort((a, b) => a - b);
      const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
      return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? 0, over20: s.filter((x) => x > 20).length };
    };
    const all: number[] = [];
    const perf: AtlasPerf = {
      frames: all,
      reset: () => {
        all.length = 0;
      },
      stats: () => stats(all),
    };
    Object.defineProperty(window, "__atlasPerf", { value: perf, configurable: true });
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      frames.push(dt);
      all.push(dt);
      if (frames.length > 240) frames.shift();
      if (now - shown > 500) {
        shown = now;
        const s = stats(frames);
        setText(`frame  p50 ${s.p50.toFixed(1)}  p95 ${s.p95.toFixed(1)}  max ${s.max.toFixed(1)} ms\nfps    ${(1000 / Math.max(1, s.mean)).toFixed(0)}   dom ${document.querySelectorAll(".atlas-camera *").length}`);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      delete (window as { __atlasPerf?: unknown }).__atlasPerf;
    };
  }, []);
  return (
    <div className="atlas-meter" aria-hidden="true">
      {text}
    </div>
  );
}
