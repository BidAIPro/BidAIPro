/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runClosingWindowRefresh } from "../lib/gsa-closing-refresh";
import { runGsaFleetClosingWindowRefresh } from "../lib/gsa-fleet-closing-refresh";
import { syncClosedGsaVehicleComps } from "../lib/gsa-closed-comp-sync";
import { fetchGsaFleetActiveListings } from "../lib/gsa-fleet-client";
import {
  GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE,
  persistGsaFleetActiveListings,
  recordGsaFleetSourceFailure,
  syncClosedGsaFleetOutcomes,
} from "../lib/gsa-fleet-persistence";
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
      const refreshes = await Promise.allSettled([
        runClosingWindowRefresh(env.DB, {
          sleep: (delayMs) => scheduler.wait(delayMs),
        }),
        runGsaFleetClosingWindowRefresh(env.DB, {
          sleep: (delayMs) => scheduler.wait(delayMs),
        }),
      ]);
      const failures = refreshes
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more closing-window refreshes failed.");
      }
      return;
    }

    if (controller.cron === "39 * * * *") {
      try {
        await syncClosedGsaVehicleComps(env.DB, {
          bootstrapDays: 2,
          overlapDays: 1,
          maxWindowDays: 7,
          detailConcurrency: 4,
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        // The sync records its own failed source check. It runs on a separate
        // cron and must never interrupt active-catalog or closing-bid refreshes.
      }
      return;
    }

    if (controller.cron === "19 * * * *") {
      const checkedAt = new Date();
      const startedMs = Date.now();
      try {
        const snapshot = await fetchGsaFleetActiveListings({
          forceRefresh: true,
          now: checkedAt,
          signal: AbortSignal.timeout(45_000),
        });
        await persistGsaFleetActiveListings(env.DB, snapshot, {
          latencyMs: Date.now() - startedMs,
        });
      } catch (error) {
        await recordGsaFleetSourceFailure(env.DB, error, {
          scope: GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE,
          checkedAt: checkedAt.toISOString(),
          latencyMs: Date.now() - startedMs,
        });
      }
      return;
    }

    if (controller.cron === "49 * * * *") {
      try {
        await syncClosedGsaFleetOutcomes(env.DB, {
          bootstrapDays: 7,
          overlapDays: 2,
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        // The Fleet sync records its own failed source check. Keep this source
        // independent from both active catalogs and closing-window refreshes.
      }
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
