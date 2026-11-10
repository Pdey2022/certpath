import { Link } from "react-router";
import type { Route } from "./+types/home";
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
    path: "/",
    title: "Exam preparation built around your certification",
    description:
      "Explore a focused certification preparation experience, with exam-specific learning and clear access information.",
    indexingEnabled: isIndexingEnabled(env.INDEXING_ENABLED),
  });

  return { seo };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return toMetaDescriptors(loaderData?.seo);
}

export default function Home() {
  return (
    <PublicLayout>
      <main id="main-content" className="public-main">
        <section className="hero" aria-labelledby="home-title">
          <p className="eyebrow">Certification preparation</p>
          <h1 id="home-title">Prepare for your next certification with focus.</h1>
          <p className="intro">
            A clear place to practise for one exam at a time, review explanations,
            and understand the learning options available for that certification.
          </p>
          <Link className="primary-link" to="/exams">
            Explore the exam catalogue
          </Link>
        </section>

        <section aria-labelledby="approach-title">
          <h2 id="approach-title">A focused study experience</h2>
          <div className="card-grid">
            <article className="card">
              <h3>Exam-specific learning</h3>
              <p>
                Study access is organized by certification rather than bundled
                into an all-exam subscription.
              </p>
            </article>
            <article className="card">
              <h3>Clear learning options</h3>
              <p>
                Standard practice and optional Pro preparation are distinct
                choices with their own access conditions.
              </p>
            </article>
            <article className="card">
              <h3>Review what you learn</h3>
              <p>
                Explanations and progress are part of the planned learning
                experience. No question bank is published on this foundation
                page.
              </p>
            </article>
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}
