import { createHashRouter } from "react-router";
import { Layout } from "./Layout";
import { routes } from "./features/registry";
import { NotFound } from "./routes/NotFound";
import { ScreenError } from "./routes/ScreenError";

/**
 * Hash routing (#/slices/SLICE-001): the Go host serves one index.html and needs no fallback rules,
 * and the one-time ?t= token in the start-up URL never collides with a route.
 * Screens live in features/<name>/ and are listed in features/registry.ts.
 *
 * Every screen sits under one pathless route with an error boundary, inside the layout: a screen
 * that fails shows ScreenError in the content area and the shell stays.
 */
export const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    errorElement: <ScreenError />,
    children: [
      {
        errorElement: <ScreenError />,
        children: [...routes, { path: "*", element: <NotFound /> }],
      },
    ],
  },
]);
