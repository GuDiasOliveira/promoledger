import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

// The browser talks only to this Next.js origin; API calls are proxied to FastAPI.
// Same origin => no CORS, and no second URL exposed to clients.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${BACKEND_URL}/api/v1/:path*` }];
  },
};

// withSerwist keeps esbuild out of the server bundle (it builds the service worker).
export default withSerwist(nextConfig);
