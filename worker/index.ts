/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runClosingWindowRefresh } from "../lib/gsa-closing-refresh";
import { getGsaVehicleAuctions } from "../lib/gsa-client";
import { persistGsaDiscovery, recordGsaSourceFailure } from "../lib/gsa-persistence";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GSA_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "* * * * *") {
      await runClosingWindowRefresh(env.DB, {
        sleep: (delayMs) => scheduler.wait(delayMs),
      });
      return;
    }

    const syncStartedAt = new Date();
    const startedMs = syncStartedAt.getTime();

    try {
      const discovery = await getGsaVehicleAuctions({
        apiKey: env.GSA_API_KEY,
        forceRefresh: true,
        now: syncStartedAt,
      });
      await persistGsaDiscovery(env.DB, discovery, {
        latencyMs: Date.now() - startedMs,
      });
    } catch (error) {
      await recordGsaSourceFailure(env.DB, error, {
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedMs,
      });
      throw error;
    }
  },
};

export default worker;
