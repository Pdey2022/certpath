export interface PublicMetadata {
  title: string;
  description: string;
  canonical: string;
  robots: "index,follow" | "noindex,nofollow";
}

export function isIndexingEnabled(value: string) {
  return String(value) === "true";
}

export function buildRobotsTxt({
  indexingEnabled,
  sitemapUrl,
}: {
  indexingEnabled: boolean;
  sitemapUrl: string;
}) {
  const lines = indexingEnabled
    ? [
        "User-agent: *",
        "Allow: /",
        "Disallow: /app",
        "Disallow: /admin",
        `Sitemap: ${sitemapUrl}`,
      ]
    : ["User-agent: *", "Disallow: /"];

  return `${lines.join("\n")}\n`;
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "\"": "&quot;",
      "'": "&apos;",
    };

    return entities[character];
  });
}

export function buildSitemapXml({
  origin,
  indexingEnabled,
}: {
  origin: string;
  indexingEnabled: boolean;
}) {
  const publicPaths = indexingEnabled ? ["/", "/exams"] : [];
  const urls = publicPaths
    .map(
      (path) =>
        `  <url><loc>${escapeXml(new URL(path, origin).href)}</loc></url>`,
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPublicMetadata({
  requestUrl,
  canonicalOrigin,
  path,
  title,
  description,
  indexingEnabled,
}: {
  requestUrl: string;
  canonicalOrigin: string;
  path: string;
  title: string;
  description: string;
  indexingEnabled: boolean;
}): PublicMetadata {
  const origin = canonicalOrigin
    ? new URL(canonicalOrigin).origin
    : new URL(requestUrl).origin;

  return {
    title,
    description,
    canonical: new URL(path, origin).href,
    robots: indexingEnabled ? "index,follow" : "noindex,nofollow",
  };
}

export function toMetaDescriptors(metadata: PublicMetadata | undefined) {
  if (!metadata) {
    return [];
  }

  return [
    { title: metadata.title },
    { name: "description", content: metadata.description },
    { name: "robots", content: metadata.robots },
    { property: "og:type", content: "website" },
    { property: "og:title", content: metadata.title },
    { property: "og:description", content: metadata.description },
    { property: "og:url", content: metadata.canonical },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: metadata.title },
    { name: "twitter:description", content: metadata.description },
    {
      tagName: "link",
      rel: "canonical",
      href: metadata.canonical,
    },
    {
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: metadata.title,
        description: metadata.description,
        url: metadata.canonical,
      },
    },
  ];
}
