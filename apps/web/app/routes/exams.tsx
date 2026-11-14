import type { Route } from "./+types/exams";
import { Link } from "react-router";
import { PublicLayout } from "../components/public-layout";
import { isPublicReleaseSite } from "../lib/release-mode";
import {
  accessPlans,
  catalogExams,
  catalogueFootnote,
  demoLink,
} from "../lib/site-content";
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
    title: "CISSP and CISM catalogue | CertPath",
    description:
      "Compare CISSP and CISM preparation. Each exam has its own Standard access and optional three-month Pro adaptive preparation.",
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
        <h1>Choose the certification you are sitting next</h1>
        <p className="intro">
          Each certification is bought and studied on its own. Access for one
          exam never includes the other, and there is no all-exam subscription.
        </p>
        <div className="card-grid section-block">
          {catalogExams.map((exam) => (
            <article className="card" key={exam.id}>
              <p className="eyebrow">{exam.fullName}</p>
              <h2>{exam.name}</h2>
              <p>{exam.summary}</p>
              <p>{exam.audience}</p>
              {!isPublicReleaseSite && (
                <Link className="primary-link" to={`/app/exams/${exam.id}`}>
                  Open the demo workspace
                </Link>
              )}
            </article>
          ))}
        </div>
        <section aria-labelledby="plans-title" className="section-block">
          <h2 id="plans-title">What Standard and Pro include</h2>
          <p>{catalogueFootnote}</p>
          <div className="card-grid">
            {accessPlans.map((plan) => (
              <article className="card" key={plan.name}>
                <h3>{plan.name}</h3>
                <p>{plan.summary}</p>
                <ul>
                  {plan.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
        <section aria-labelledby="next-title">
          <h2 id="next-title">Not ready to choose?</h2>
          <p>
            The demo uses synthetic questions to show practice, a timed mock, and
            the Pro adaptive flow before anything is published for sale.
          </p>
          <a className="primary-link" href={demoLink.href}>
            {demoLink.label}
          </a>
        </section>
      </main>
    </PublicLayout>
  );
}
