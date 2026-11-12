// Loads the simulation's TypeScript sources into node's test runner.
//
// Node strips the types itself (erasable syntax only). The sources import each other without file
// extensions, as the app's tsconfig requires (allowImportingTsExtensions is off), so this resolve
// hook tries `<specifier>.ts` and `<specifier>/index.ts` for relative imports node cannot find.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // try the next form
        }
      }
      throw error;
    }
  },
});

export const sim = await import("../src/sim/index.ts");
export const scene = await import("../src/scene/store.ts");
