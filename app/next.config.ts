import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every route prerenders with no server work, so the whole app ships as
  // static files. This is what makes it deployable to Cloudflare's asset
  // hosting with no Next.js adapter and no server runtime involved.
  output: "export",
  images: { unoptimized: true },
  webpack: (config, { isServer }) => {
    // `@base-org/account` ships a Node build that pulls in `@coinbase/cdp-sdk`,
    // whose optional `@x402/evm` peer is not installed. The Base Account
    // connector only reaches the SDK in the browser at connect time, so the
    // server/prerender bundle stubs it out instead of tracing that graph.
    if (isServer) {
      config.resolve.alias = { ...config.resolve.alias, "@base-org/account": false };
    }
    return config;
  },
};

export default nextConfig;
