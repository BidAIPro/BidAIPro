/**
 * Build-time stand-in used only while pre-rendering the GitHub Pages frontend.
 * API routes are skipped by the static exporter and execute on the Sites
 * backend, so no Cloudflare binding is read in this build.
 */
export const env = Object.freeze({});
