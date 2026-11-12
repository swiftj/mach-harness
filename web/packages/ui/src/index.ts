/**
 * @mach/ui: the MACH design system. See docs/mach-next/DESIGN_SYSTEM.md.
 *
 *   import "@mach/ui/styles.css";            once, in the app's entry CSS
 *   import { Button, AppShell } from "@mach/ui";
 *   import { createClient } from "@mach/ui/api";
 *   import { ProductGraph } from "@mach/ui/graph";   and "@mach/ui/graph.css"
 */
export * from "./lib/cn";
export * from "./lib/format";
export * from "./tokens/tokens";
export * from "./theme/ThemeProvider";
export * from "./motion/motion";

export * from "./components/tone";
export * from "./components/button";
export * from "./components/spinner";
export * from "./components/field";
export * from "./components/input";
export * from "./components/select";
export * from "./components/checkbox";
export * from "./components/dialog";
export * from "./components/confirm-dialog";
export * from "./components/hint";
export * from "./components/focus-return";
export * from "./components/sheet";
export * from "./components/popover";
export * from "./components/tooltip";
export * from "./components/tabs";
export * from "./components/badge";
export * from "./components/typography";
export * from "./components/skeleton";
export * from "./components/states";
export * from "./components/banner";
export * from "./components/toast";
export * from "./components/rich-text";
export * from "./components/detail";

export * from "./shell";
export * from "./lifecycle";
export * from "./spec";
export * from "./api";

// Factory grammar (M6). Additive; a `./factory` export path is proposed to the lead.
export * from "./factory";
