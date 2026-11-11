import { createHashRouter } from "react-router";
import { Layout } from "./Layout";
import { routes } from "./features/registry";
import { NotFound } from "./routes/NotFound";

/**
 * Hash routing (#/slices/SLICE-001): the Go host serves one index.html and needs no fallback rules,
 * and the one-time ?t= token in the start-up URL never collides with a route.
 * Screens live in features/<name>/ and are listed in features/registry.ts.
 */
export const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [...routes, { path: "*", element: <NotFound /> }],
  },
]);
