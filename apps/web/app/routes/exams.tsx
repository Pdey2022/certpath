import type { Route } from "./+types/exams";
import { PublicLayout } from "../components/public-layout";
import { cloudflareContext } from "../lib/cloudflare-context";
import {
  buildPublicMetadata,
  isIndexingEnabled,
  toMetaDescriptors,
} from "../lib/seo";

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const seo = buildPublicMetadata({
    requestUrl: request.url,
    canonicalOrigin: env.PUBLIC_SITE_ORIGIN,
    path: "/exams",
    title: "Exam catalogue | Exam Prep",
    description:
      "Browse certification preparation options. Exam listings and sample questions are published only after content review and approval.",
    indexingEnabled: isIndexingEnabled(env.INDEXING_ENABLED),
  });

  return { seo };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return toMetaDescriptors(loaderData?.seo);
}

export default function Exams() {
  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <p className="eyebrow">Exam catalogue</p>
        <h1>Choose a certification to explore</h1>
        <p className="intro">
          Certification listings and public sample questions will appear here
          after their content and publication status are approved. No paid
          question content is included in this catalogue.
        </p>
      </main>
    </PublicLayout>
  );
}
