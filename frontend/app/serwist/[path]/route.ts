import { createSerwistRoute } from "@serwist/turbopack";

// Builds and serves /serwist/sw.js (Serwist's Turbopack integration).
// Only `generateStaticParams` and `GET` are re-exported: the route segment config Serwist
// also returns (`dynamic`, `dynamicParams`, `revalidate`) is not allowed with Cache Components.
const route = createSerwistRoute({
  swSrc: "app/sw.ts",
  useNativeEsbuild: true,
});

export const { generateStaticParams, GET } = route;
