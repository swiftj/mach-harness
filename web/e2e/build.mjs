// Builds the host with the app embedded, in a scratch folder, and prints the binary's path:
//   export E2E_BINARY=$(node web/e2e/build.mjs)
import { buildHost } from "./lib/build.mjs";
const { binary } = buildHost();
console.log(binary);
