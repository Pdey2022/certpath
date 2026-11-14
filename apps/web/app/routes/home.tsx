import { Link } from "react-router";
import { isUiPreview } from "../lib/preview-mode";
import { isPublicReleaseSite } from "../lib/release-mode";
import {
  accessPlans,
  availabilityNotice,
  catalogueFootnote,
  demoLink,
  independenceNotice,
} from "../lib/site-content";
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
    title: "CertPath | CISSP and CISM exam preparation",
    description:
      "Exam-specific preparation for CISSP and CISM. Compare Standard practice access with optional Pro adaptive preparation, then try the demo.",
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
          <h1 id="home-title">Prepare for one certification at a time.</h1>
          <p className="intro">
            CertPath focuses on the exam in front of you. Study CISSP or CISM
            with exam-specific practice, read the explanation for every answer,
            and see your progress before you sit the real exam.
          </p>
          {isPublicReleaseSite ? (
            <div className="button-row" role="group" aria-label="Get started">
              <a className="primary-link" href={demoLink.href}>
                {demoLink.label}
              </a>
              <Link className="secondary-link" to="/exams">
                Compare Standard and Pro
              </Link>
            </div>
          ) : (
            <Link className="primary-link" to="/exams">
              Explore the exam catalogue
            </Link>
          )}
        </section>

        {isUiPreview && (
          <section aria-labelledby="walkthrough-title">
            <h2 id="walkthrough-title">Demo walkthrough</h2>
            <p className="prototype-notice" role="note">
              Preview only: synthetic data, no sign-in, no saved progress, no
              payments. Role switching is a client-side demo control.
            </p>
            <ul>
              <li><Link to="/exams">Exam catalogue</Link></li>
              <li><Link to="/app">Learner dashboard</Link></li>
              <li><Link to="/app/exams/cissp">CISSP workspace</Link></li>
              <li><Link to="/app/practice">Practice</Link></li>
              <li><Link to="/app/exams/cissp/mock">Timed mock preview</Link></li>
              <li><Link to="/app/progress">Progress</Link></li>
              <li><Link to="/admin">Global Admin preview</Link></li>
              <li><Link to="/admin?demoRole=manager">Manager preview</Link></li>
            </ul>
          </section>
        )}
        <section aria-labelledby="access-title">
          <h2 id="access-title">Standard and Pro access</h2>
          <p className="intro">{catalogueFootnote}</p>
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
        <section aria-labelledby="approach-title">
          <h2 id="approach-title">How study works here</h2>
          <div className="card-grid">
            <article className="card">
              <h3>Exam-specific learning</h3>
              <p>
                Study access is organized by certification rather than bundled
                into an all-exam subscription.
              </p>
            </article>
            <article className="card">
              <h3>Explanations with every question</h3>
              <p>
                Each answer comes with reasoning you can review, so a mistake
                becomes a study note rather than a dead end.
              </p>
            </article>
            <article className="card">
              <h3>Progress you can trust</h3>
              <p>
                Attempts are saved, so you can resume practice and see how a mock
                exam went, including where your weaker areas are.
              </p>
            </article>
          </div>
        </section>
        {isPublicReleaseSite && (
          <section aria-labelledby="availability-title">
            <h2 id="availability-title">Availability</h2>
            <p>{availabilityNotice}</p>
            <p className="small-print">{independenceNotice}</p>
          </section>
        )}
      </main>
    </PublicLayout>
  );
}
