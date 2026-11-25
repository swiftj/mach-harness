// The parts of @mach/ui the Atlas's pure modules use (test/_atlas.mjs maps "@mach/ui" here in tests):
// the tokens, the projection and geometry, the motion curves, the grammar and the cell's anatomy.
export * from "../../../../packages/ui/src/tokens/tokens.ts";
export * from "../../../../packages/ui/src/factory/projection.ts";
export * from "../../../../packages/ui/src/factory/geometry.ts";
export * from "../../../../packages/ui/src/factory/motion.ts";
export * from "../../../../packages/ui/src/factory/grammar.ts";
export { cellAnatomy } from "../../../../packages/ui/src/factory/plates.tsx";
