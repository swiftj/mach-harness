/**
 * Development entry for the Factory Atlas alone, before the shell exists: /dev/atlas.html.
 * ?theme=light|dark pins the theme; ?meter shows the frame meter; ?t=<factory ms> seeks; ?play=16 plays.
 * The capture script drives it through window.__machSim. Not part of the build.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../src/index.css";
import { AtlasView } from "../src/atlas";
import { getSceneStore } from "../src/scene";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const store = getSceneStore();
if (params.has("t")) store.seek(Number(params.get("t")));
if (params.has("play")) {
  store.setSpeed(Number(params.get("play")) as 16);
  store.play();
}

function Stamp() {
  return (
    <div
      style={{ position: "fixed", left: 16, top: 16, padding: "3px 8px", borderRadius: 4, background: "var(--mach-warning-soft)", border: "1px solid var(--mach-warning-line)", color: "var(--mach-warning-ink)", font: "700 11px/1.4 var(--mach-font-sans)", letterSpacing: "0.04em", pointerEvents: "none" }}
    >
      SIMULATION · Factory Atlas dev entry
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <main style={{ position: "fixed", inset: 0 }}>
          <AtlasView meter={params.has("meter")} />
          <Stamp />
        </main>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
