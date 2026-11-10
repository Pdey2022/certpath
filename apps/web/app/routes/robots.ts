import type { Route } from "./+types/robots";
import { cloudflareContext } from "../lib/cloudflare-context";
import { buildRobotsTxt, isIndexingEnabled } from "../lib/seo";

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const body = buildRobotsTxt({
    indexingEnabled: isIndexingEnabled(env.INDEXING_ENABLED),
    sitemapUrl: new URL("/sitemap.xml", request.url).href,
  });

  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
