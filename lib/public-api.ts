const configuredApiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN
  ?.trim()
  .replace(/\/+$/, "");

export function publicApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return configuredApiOrigin
    ? `${configuredApiOrigin}${normalizedPath}`
    : normalizedPath;
}
