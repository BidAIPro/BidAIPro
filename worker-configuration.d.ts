declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    GSA_API_KEY?: string;
    KBB_API_KEY?: string;
    MARKETCHECK_API_KEY?: string;
    BLACKBOOK_API_KEY?: string;
  }
}
