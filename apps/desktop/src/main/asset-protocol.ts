export const ASSET_SCHEME = "fantastic-asset";

const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function parseAssetHandleUrl(requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== `${ASSET_SCHEME}:`
    || url.hostname !== "asset"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !url.pathname.startsWith("/")
  ) return undefined;
  const handleId = url.pathname.slice(1);
  return UUID_PATTERN.test(handleId) ? handleId : undefined;
}