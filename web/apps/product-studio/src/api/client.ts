import { createClient, type Transport } from "@mach/ui/api";

/**
 * The app's single client. In production it calls its own origin (the Go host serves the app and
 * the API together). In `vite --mode fixtures` it answers from web/fixtures; Vite replaces
 * import.meta.env.MODE at build time, so the production bundle contains no fixture code or data.
 */
const fixtureTransport: Transport | undefined =
  import.meta.env.MODE === "fixtures"
    ? async (request) => (await import("../dev/fixtureTransport")).fixtureTransport(request)
    : undefined;

export const client = createClient({ transport: fixtureTransport });

export const usingFixtures = import.meta.env.MODE === "fixtures";
