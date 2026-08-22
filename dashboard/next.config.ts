import path from "node:path";
import type { NextConfig } from "next";

// The Python capture server. Proxying it through Next means the browser only
// ever talks to one origin, so there is no CORS to configure on the Python side.
const SERVER = process.env.MARBLE_SERVER ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // pin the root, otherwise a stray lockfile further up the tree wins
  turbopack: { root: path.resolve(__dirname) },

  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${SERVER}/:path*` }];
  },
};

export default nextConfig;
