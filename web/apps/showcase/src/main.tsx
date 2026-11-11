import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, Toaster, type ProductName, type ThemePreference } from "@mach/ui";
import "./index.css";
import { App } from "./App";

// ?theme=light|dark and ?product=control-tower let the screenshot script pin what it captures.
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const product: ProductName = params.get("product") === "control-tower" ? "control-tower" : "product-studio";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider
      product={product}
      persist={false}
      defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}
    >
      <TooltipProvider>
        <App product={product} />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
