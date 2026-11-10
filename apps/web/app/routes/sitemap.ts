import type { Route } from "./+types/sitemap";
import { cloudflareContext } from "../lib/cloudflare-context";
import { buildSitemapXml, isIndexingEnabled } from "../lib/seo";

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const origin = env.PUBLIC_SITE_ORIGIN
    ? new URL(env.PUBLIC_SITE_ORIGIN).origin
    : new URL(request.url).origin;
  const body = buildSitemapXml({
    origin,
    indexingEnabled: isIndexingEnabled(env.INDEXING_ENABLED),
  });

  return new Response(`${body}\n`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
