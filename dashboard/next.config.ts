import path from "node:path";
import type { NextConfig } from "next";

// The Python server, which is the only thing the dashboard talks to. It owns the world map,
// the live feed, the jobs and - since the fleet grew past one agent - the drone cameras too.
// Proxying it through Next means the browser only ever talks to one origin, so there is no
// CORS to configure on the Python side and a phone on the LAN only has to reach this app.
const SERVER = process.env.MARBLE_SERVER ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // pin the root, otherwise a stray lockfile further up the tree wins
  turbopack: { root: path.resolve(__dirname) },

  async rewrites() {
    return [
      { source: "/backend/:path*", destination: `${SERVER}/:path*` },
    ];
  },

  allowedDevOrigins: ['10.0.0.250']
};

export default nextConfig;
