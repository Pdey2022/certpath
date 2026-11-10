import type { Route } from "./+types/exams";
import { Link } from "react-router";
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
          This interactive prototype uses clearly labelled synthetic catalogue
          entries. They are not publication approvals or payment offers. No
          sample questions, prices, or paid question content are included here.
        </p>
        <div className="prototype-notice" role="note">
          Synthetic prototype catalogue · no official affiliation or live access offer.
        </div>
        <div className="card-grid section-block">
          {["CISSP", "CISM"].map((certification) => (
            <article className="card" key={certification}>
              <p className="eyebrow">Synthetic catalogue example</p>
              <h2>{certification}</h2>
              <p>
                Example exam-specific workspace. Standard and optional three-month
                Pro access are shown in the demo; no price or purchase is configured.
              </p>
              <Link className="primary-link" to={`/app/exams/${certification.toLowerCase()}`}>
                Open prototype workspace
              </Link>
            </article>
          ))}
        </div>
      </main>
    </PublicLayout>
  );
}
