/**
 * Development entry for the Execution Blueprint alone, before the shell exists: /dev/blueprint.html.
 * ?theme=light|dark pins the theme; ?t=<factory ms> seeks; ?play=16 plays at that speed; ?meter shows
 * frame times (also on window.__bpMeter for the capture script). The script drives the rest through
 * window.__machSim. Not part of the build.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../src/index.css";
import { BlueprintView } from "../src/blueprint";
import { getSceneStore, useSceneStore } from "../src/scene";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const store = getSceneStore();
store.setView("blueprint");
if (params.has("t")) store.seek(Number(params.get("t")));
if (params.has("play")) {
  store.setSpeed(Number(params.get("play")) as 16);
  store.play();
}

/** Frame times, measured with requestAnimationFrame: the last 600 frames. */
const meter = { frames: [] as number[], reset() { this.frames = []; } };
(window as unknown as { __bpMeter: typeof meter }).__bpMeter = meter;
let last = performance.now();
const tick = (now: number) => {
  meter.frames.push(now - last);
  if (meter.frames.length > 600) meter.frames.shift();
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

function Meter() {
  const [text, setText] = useState("");
  useEffect(() => {
    const id = window.setInterval(() => {
      const f = [...meter.frames].sort((a, b) => a - b);
      if (!f.length) return;
      const p = (q: number) => f[Math.min(f.length - 1, Math.floor(q * f.length))]!.toFixed(1);
      setText(`frames ${f.length} · p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${p(1)} ms`);
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return <div style={{ position: "fixed", right: 16, top: 16, font: "11px var(--mach-font-mono)", color: "var(--mach-ink-muted)", pointerEvents: "none" }}>{text}</div>;
}

function Stamp() {
  const t = useSceneStore((s) => Math.floor(s.playhead / 1000));
  const playing = useSceneStore((s) => s.playing);
  return (
    <div style={{ position: "fixed", left: 16, top: 16, display: "flex", gap: 8, alignItems: "center", pointerEvents: "none" }}>
      <span style={{ padding: "3px 8px", borderRadius: 4, background: "var(--mach-warning-soft)", border: "1px solid var(--mach-warning-line)", color: "var(--mach-warning-ink)", font: "700 11px/1.4 var(--mach-font-sans)", letterSpacing: "0.04em" }}>SIMULATION · Execution Blueprint dev entry</span>
      <span style={{ font: "11px var(--mach-font-mono)", color: "var(--mach-ink-muted)" }}>
        {Math.floor(t / 60)}:{String(t % 60).padStart(2, "0")} {playing ? "▶" : "❚❚"}
      </span>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <div style={{ position: "fixed", inset: 0 }}>
          <BlueprintView />
          <Stamp />
          {params.has("meter") ? <Meter /> : null}
        </div>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
