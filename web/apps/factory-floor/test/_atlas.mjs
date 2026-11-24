// Loads the Atlas's pure modules (layout, locate) into node's test runner. They import the drawing
// primitives' geometry from @mach/ui, whose index also pulls in the React components and styles; for
// the tests, "@mach/ui" resolves to the parts the geometry needs (test/fixtures/mach-ui-geometry.mjs),
// and the one .tsx among them (factory/plates.tsx, where cellAnatomy lives) is transpiled with the
// app's own TypeScript. Import this before importing src/atlas/*.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const shim = new URL("./fixtures/mach-ui-geometry.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@mach/ui") return { url: shim, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      return nextResolve(`${specifier}.tsx`, context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

await import("./_load.mjs");
export const layout = await import("../src/atlas/layout.ts");
export const locateModule = await import("../src/atlas/locate.ts");
