import { createHashRouter } from "react-router";
import { Layout } from "./Layout";
import { Home } from "./routes/Home";
import { NotFound } from "./routes/NotFound";

/**
 * Hash routing (#/slices/SLICE-001): the Go host serves one index.html and needs no fallback rules,
 * and the one-time ?t= token in the start-up URL never collides with a route. Add screens as children.
 */
export const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
