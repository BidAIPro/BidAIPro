import type { NextConfig } from "next";
import path from "node:path";

const isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  ...(isGitHubPagesBuild
    ? {
        output: "export" as const,
        basePath: "/BidAIPro",
        trailingSlash: true,
        images: { unoptimized: true },
        webpack(config, { webpack }) {
          config.plugins.push(
            new webpack.NormalModuleReplacementPlugin(
              /^cloudflare:workers$/,
              path.resolve("./lib/cloudflare-workers-static.ts"),
            ),
          );
          return config;
        },
      }
    : {}),
};

export default nextConfig;
