const STUB_URL = "data:text/javascript,export const env = Object.freeze({});";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: STUB_URL };
  }
  return nextResolve(specifier, context);
}
