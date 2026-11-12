import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "./index.css";
import { App } from "./App";

// ?theme=light|dark lets the capture script pin what it records.
const theme = new URLSearchParams(window.location.search).get("theme");

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider
      product="control-tower"
      persist={false}
      defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}
    >
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
