import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import type { Route } from "./+types/learner";

import { PracticeDemo } from "../components/practice-demo";
import { DemoTimedMock } from "../components/demo-timed-mock";
import { DemoMockDashboardLinks } from "../components/demo-mock-dashboard-links";
import { DemoProMockDashboardLinks } from "../components/demo-pro-mock-dashboard-links";
import { DemoAdaptiveMock } from "../components/demo-adaptive-mock";
import { WorkspaceShell } from "../components/workspace-shell";
import {
  demoToday,
  demoQuestions,
  getProAccessState,
  parsePracticeDemoState,
  practiceDemoStorageKey,
  proDurationMonths,
  type DemoEntitlement,
  type PracticeDemoState,
  type ProAccessState,
} from "../lib/prototype-data";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Learner workspace preview | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

const learnerLinks = [
  { label: "Home", to: "/app" },
  { label: "My Exams", to: "/app/exams" },
  { label: "Practice", to: "/app/practice" },
  { label: "Progress", to: "/app/progress" },
  { label: "Account", to: "/app/account" },
];

const demoEntitlements: Record<string, DemoEntitlement> = {
  CISSP: {
    standardEndsAt: "2027-06-30T00:00:00.000Z",
    proStartsAt: "2026-10-10T00:00:00.000Z",
    proEndsAt: "2027-01-10T00:00:00.000Z",
  },
  CISM: { standardEndsAt: "2027-06-30T00:00:00.000Z" },
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string) {
  return dateFormatter.format(new Date(value));
}

function statusLabel(status: ProAccessState) {
  return {
    "no-standard": "No Standard",
    eligible: "Eligible",
    insufficient: "Insufficient Standard coverage",
    active: "Active",
    expired: "Expired",
  }[status];
}

function AccessLine({
  certification,
  entitlement,
}: {
  certification: string;
  entitlement: DemoEntitlement;
}) {
  const state = getProAccessState(entitlement, new Date(demoToday));
  return (
    <article className="access-card">
      <div className="access-card-heading">
        <h3>{certification}</h3>
        <span className={`state-pill state-pill--${state}`}>{statusLabel(state)}</span>
      </div>
      <dl className="access-dates">
        <div>
          <dt>Standard</dt>
          <dd>
            {entitlement.standardEndsAt
              ? `Ends ${formatDate(entitlement.standardEndsAt)}`
              : "No active access"}
          </dd>
        </div>
        <div>
          <dt>Pro</dt>
          <dd>
            {entitlement.proEndsAt
              ? `${formatDate(entitlement.proStartsAt ?? entitlement.proEndsAt)} – ends ${formatDate(entitlement.proEndsAt)} · 3 months`
              : "Not active"}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function DemoNotice() {
  return (
    <p className="prototype-notice" role="note">
      Synthetic prototype data · not an account, purchase, or official exam result.
    </p>
  );
}

function ContinuePracticeCard() {
  const [saved, setSaved] = useState<PracticeDemoState | null | undefined>(undefined);

  useEffect(() => {
    try {
      setSaved(parsePracticeDemoState(window.localStorage.getItem(practiceDemoStorageKey)));
    } catch {
      setSaved(null);
    }
  }, []);

  const answered = saved ? saved.answers.filter((answer) => answer !== null).length : 0;

  return (
    <article className="feature-card">
      <p className="eyebrow">Continue studying · CISSP</p>
      <h2>{saved ? "Pick up your practice" : "Start your practice"}</h2>
      {saved === undefined ? (
        <p role="status">Checking this browser for a saved session…</p>
      ) : saved ? (
        <>
          <p>
            Question {saved.questionIndex + 1} of {demoQuestions.length} · {answered} answered ·
            saved in this browser
          </p>
          <Link className="button-primary" to="/app/practice/session">
            Continue practice
          </Link>
        </>
      ) : (
        <>
          <p>No saved practice session in this browser yet.</p>
          <Link className="button-primary" to="/app/practice/setup">
            Start practice
          </Link>
        </>
      )}
    </article>
  );
}

function LearnerHome() {
  return (
    <>
      <DemoNotice />
      <p className="eyebrow">Tuesday, 10 November 2026 · synthetic demo</p>
      <h1>Welcome back, learner</h1>
      <section className="dashboard-grid">
        <ContinuePracticeCard />
        <article className="card recommendation-card">
          <p className="eyebrow">Recommended next</p>
          <h2>Review Security and Risk Management</h2>
          <p>Suggested from 12 first-seen sample answers. Synthetic demo rationale.</p>
          <Link className="button-secondary" to="/app/exams/cissp/practice">
            See practice options
          </Link>
        </article>
      </section>

      <section className="section-block" aria-labelledby="my-exams-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Separate access by certification</p>
            <h2 id="my-exams-title">Your exams</h2>
          </div>
          <Link to="/app/exams">View all exams</Link>
        </div>
        <div className="access-grid">
          {Object.entries(demoEntitlements).map(([name, entitlement]) => (
            <div className="access-card" key={name}>
              <AccessLine certification={name} entitlement={entitlement} />
              <Link className="button-secondary" to={`/app/exams/${name.toLowerCase()}`}>
                Open {name}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section className="card-grid section-block" aria-label="Study tools and progress">
        <article className="card">
          <h2>Practice</h2>
          <p>Try original illustrative sample questions with explanations.</p>
          <Link to="/app/practice/setup">Set up practice</Link>
        </article>
        <DemoMockDashboardLinks />
        <article className="card">
          <h2>Progress</h2>
          <p>See first-seen and repeated-question sample statistics separately.</p>
          <Link to="/app/progress">View progress</Link>
        </article>
      </section>

      <section className="card-grid section-block" aria-label="Pro adaptive mock attempts">
        <DemoProMockDashboardLinks />
      </section>
    </>
  );
}

function ExamList() {
  return (
    <>
      <DemoNotice />
      <p className="eyebrow">My exams</p>
      <h1>Certification access</h1>
      <p className="intro">
        Each certification has independent Standard and Pro coverage. Dates below are synthetic.
      </p>
      <div className="access-grid">
        {Object.entries(demoEntitlements).map(([name, entitlement]) => (
          <article className="access-card" key={name}>
            <AccessLine certification={name} entitlement={entitlement} />
            <p>Standard includes practice, explanations, normal mock previews and progress.</p>
            <Link className="button-primary" to={`/app/exams/${name.toLowerCase()}`}>
              Open exam workspace
            </Link>
            <Link to={`/app/exams/${name.toLowerCase()}/pro`}>View Pro access</Link>
          </article>
        ))}
      </div>
    </>
  );
}

function ExamWorkspace({
  certification,
  section,
}: {
  certification: string;
  section: string;
}) {
  const name = certification.toUpperCase() === "CISM" ? "CISM" : "CISSP";
  const entitlement = demoEntitlements[name];
  const workspaceSections = [
    ["Overview", `/app/exams/${name.toLowerCase()}`],
    ["Practice", `/app/exams/${name.toLowerCase()}/practice`],
    ["Mock exams", `/app/exams/${name.toLowerCase()}/mock`],
    ["Pro", `/app/exams/${name.toLowerCase()}/pro`],
    ["History", `/app/exams/${name.toLowerCase()}/history`],
  ];

  return (
    <>
      <DemoNotice />
      <p className="eyebrow">Exam workspace · sample syllabus version 2026</p>
      <h1>{name} preparation</h1>
      <p className="intro">
        Standard and Pro are separate for this certification. Synthetic dates are for display only.
      </p>
      <nav className="section-tabs" aria-label={`${name} workspace sections`}>
        {workspaceSections.map(([label, to]) => (
          <Link
            aria-current={
              (section === "" && label === "Overview") ||
              section === label.toLowerCase().replace(" exams", "").replace(" ", "-")
                ? "page"
                : undefined
            }
            key={to}
            to={to}
          >
            {label}
          </Link>
        ))}
      </nav>

      {section === "practice" ? (
        <PracticeSetup certification={name} />
      ) : section === "mock" || section === "mock/active" ? (
        <MockSetup
          certification={name}
          active={section === "mock/active"}
        />
      ) : section === "pro" ||
        section === "pro/preview" ||
        section === "pro/preview/session" ? (
        <ProPreview
          certification={name}
          preview={section === "pro/preview"}
          showSession={section === "pro/preview/session"}
        />
      ) : section === "history" ? (
        <ExamHistory certification={name} />
      ) : (
        <>
          <div className="access-grid section-block">
            <AccessLine certification={name} entitlement={entitlement} />
            <article className="card">
              <p className="eyebrow">Target exam date</p>
              <h2>Not set</h2>
              <p>No target date is configured in this prototype.</p>
            </article>
          </div>
          <div className="feature-grid section-block">
            <article className="card">
              <h2>Practice</h2>
              <p>Original illustrative questions, explanations, and bookmarks.</p>
              <Link className="button-primary" to={`/app/exams/${name.toLowerCase()}/practice`}>
                Choose practice
              </Link>
            </article>
            <article className="card">
              <h2>Normal mock exam</h2>
              <p>Review the instructions; the attempt screen uses a static demonstration timer.</p>
              <Link className="button-primary" to={`/app/exams/${name.toLowerCase()}/mock`}>
                Mock instructions
              </Link>
            </article>
            <article className="card">
              <h2>Pro preparation</h2>
              <p>Three-month add-on. Same-certification Standard must cover its full duration.</p>
              <Link className="button-primary" to={`/app/exams/${name.toLowerCase()}/pro`}>
                View Pro states
              </Link>
            </article>
          </div>
          <p>
            <Link to={`/app/exams/${name.toLowerCase()}/history`}>
              View synthetic attempt history
            </Link>
          </p>
        </>
      )}
    </>
  );
}

function PracticeSetup({ certification }: { certification: string }) {
  return (
    <section className="card setup-card">
      <p className="eyebrow">Practice setup · {certification}</p>
      <h2>Choose a short practice set</h2>
      <div className="form-grid">
        <label>
          Domains
          <select defaultValue="all">
            <option value="all">All available domains</option>
            <option value="risk">Security and Risk Management</option>
            <option value="asset">Asset Security</option>
          </select>
        </label>
        <label>
          Question pool
          <select defaultValue="unanswered">
            <option value="unanswered">Unanswered first</option>
            <option value="incorrect">Previously incorrect</option>
            <option value="bookmarked">Bookmarked</option>
          </select>
        </label>
        <label>
          Sample question count
          <select defaultValue="3">
            <option value="3">3 questions · all illustrative samples</option>
          </select>
        </label>
      </div>
      <p>3 original illustrative sample questions match these demo filters.</p>
      <Link className="button-primary" to="/app/practice/session">
        Start sample practice
      </Link>
      <p className="muted">
        This demonstration supports selection, submission, explanations, bookmarks and local demo resume.
      </p>
    </section>
  );
}

function MockSetup({
  certification,
  active,
}: {
  certification: "CISSP" | "CISM";
  active: boolean;
}) {
  return active ? (
    <DemoTimedMock
      exam={certification === "CISM" ? "cism" : "cissp"}
      leaveTo={`/app/exams/${certification.toLowerCase()}/mock`}
    />
  ) : (
    <section className="card setup-card">
      <p className="eyebrow">Mock instructions · {certification}</p>
      <h2>Before you begin</h2>
      <ul className="instruction-list">
        <li>This synthetic mock has 3 sample questions and a 3-minute countdown.</li>
        <li>The timer does not pause: it keeps running if you refresh or leave this page.</li>
        <li>When time expires, your saved answers are submitted automatically.</li>
        <li>The attempt is saved in this browser only, so you can resume it here. Nothing is sent to a server.</li>
      </ul>
      <Link className="button-primary" to={`/app/exams/${certification.toLowerCase()}/mock/active`}>
        Open timed mock
      </Link>
    </section>
  );
}

function ProPreview({
  certification,
  preview,
  showSession,
}: {
  certification: string;
  preview: boolean;
  showSession: boolean;
}) {
  const samples: Array<{
    label: string;
    exam: string;
    entitlement: DemoEntitlement;
    note: string;
  }> = [
    {
      label: "Active",
      exam: "CISSP",
      entitlement: demoEntitlements.CISSP,
      note: "Active Pro add-on; CISSP Standard continues beyond it.",
    },
    {
      label: "Eligible",
      exam: "CISM",
      entitlement: demoEntitlements.CISM,
      note: "Same-exam Standard covers a full three calendar months from the demo date.",
    },
    {
      label: "Insufficient coverage",
      exam: "CISM",
      entitlement: { standardEndsAt: "2026-12-15T00:00:00.000Z" },
      note: "This synthetic scenario has too little CISM Standard coverage for the full add-on.",
    },
    {
      label: "Expired",
      exam: "CISSP",
      entitlement: {
        standardEndsAt: "2027-06-30T00:00:00.000Z",
        proStartsAt: "2026-07-10T00:00:00.000Z",
        proEndsAt: "2026-10-10T00:00:00.000Z",
      },
      note: "A previous three-month Pro period has ended; Standard remains separate.",
    },
  ];

  return (
    <section className="section-block">
      <div className="notice" role="note">
        <strong>Pro is a three-calendar-month add-on.</strong> It requires Standard access for the
        same certification throughout its full duration. No price is configured or displayed.
      </div>
      <h2>{certification} Pro access states</h2>
      <p>These are labelled synthetic examples, not account entitlements or purchase options.</p>
      <div className="access-grid">
        {samples.map((sample) => {
          const state = getProAccessState(sample.entitlement, new Date(demoToday));
          return (
            <article className="access-card" key={sample.label}>
              <div className="access-card-heading">
                <h3>{sample.label}</h3>
                <span className={`state-pill state-pill--${state}`}>{statusLabel(state)}</span>
              </div>
              <p>{sample.exam} · {sample.note}</p>
              <p>
                Standard:{" "}
                {sample.entitlement.standardEndsAt
                  ? `ends ${formatDate(sample.entitlement.standardEndsAt)}`
                  : "not active"}
              </p>
              <p>Pro duration: {proDurationMonths} calendar months.</p>
              {state === "active" ? (
                <Link
                  className="button-secondary"
                  to={`/app/exams/${sample.exam.toLowerCase()}/pro/preview`}
                >
                  Open Pro preparation preview
                </Link>
              ) : state === "insufficient" ? (
                <p className="muted">
                  Extend same-exam Standard to cover the full period. Extension pricing is not configured.
                </p>
              ) : state === "eligible" ? (
                <>
                  <p className="muted">Purchase is not available in this prototype.</p>
                  <Link
                    className="button-secondary"
                    to={`/app/exams/${sample.exam.toLowerCase()}/pro/preview`}
                  >
                    Open CertPath demo
                  </Link>
                </>
              ) : state === "expired" ? (
                <p className="muted">Expired Pro does not remove Standard access.</p>
              ) : (
                <p className="muted">Standard access is required first.</p>
              )}
            </article>
          );
        })}
      </div>
      {preview && (
        <ProPreparationPreview certification={certification} />
      )}
      {showSession && (
        <DemoAdaptiveMock
          exam={certification === "CISM" ? "cism" : "cissp"}
          leaveTo={`/app/exams/${certification.toLowerCase()}/pro/preview`}
        />
      )}
    </section>
  );
}

function ProPreparationPreview({ certification }: { certification: string }) {
  return (
    <section className="card section-block">
      <p className="eyebrow">CertPath demo · adaptive Pro mock</p>
      <h2>{certification} simulation setup</h2>
      <ul className="instruction-list">
        <li>The demo uses the three existing synthetic questions, each once.</li>
        <li>A correct answer targets Intermediate next; an incorrect answer targets Foundational when available.</li>
        <li>Submitted answers are locked. The attempt resumes from this browser's saved state.</li>
      </ul>
      <p className="notice" role="note">
        This synthetic demo does not grant Pro access. Its small illustrative heuristic is not a validated adaptive exam, official score, or readiness prediction.
      </p>
      <div className="button-row">
        <Link className="button-primary" to={`/app/exams/${certification.toLowerCase()}/pro/preview/session`}>
          Start adaptive mock demo
        </Link>
        <Link className="button-secondary" to={`/app/exams/${certification.toLowerCase()}/pro`}>
          Back to Pro states
        </Link>
      </div>
    </section>
  );
}

function ExamHistory({ certification }: { certification: string }) {
  return (
    <>
      <h2>{certification} history</h2>
      <p>Sample records only. These are not saved attempts or official results.</p>
      <div className="table-scroll">
        <table>
          <caption>Synthetic practice history</caption>
          <thead>
            <tr><th scope="col">Date</th><th scope="col">Activity</th><th scope="col">Result</th></tr>
          </thead>
          <tbody>
            <tr><td>08 Nov 2026</td><td>Practice · Security and Risk Management</td><td>7 / 10 sample questions</td></tr>
            <tr><td>05 Nov 2026</td><td>Practice · Mixed domains</td><td>6 / 10 sample questions</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function PracticeHub() {
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    try {
      const state = parsePracticeDemoState(
        window.localStorage.getItem("certpath-demo-practice-v1"),
      );
      setBookmarks(state?.bookmarks ?? []);
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : "Browser demo data could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <>
      <DemoNotice />
      <p className="eyebrow">Illustrative sample content</p>
      <h1>Practice</h1>
      <div className="dashboard-grid">
        <article className="card">
          <h2>Continue CISSP practice</h2>
          <p>3 original questions · resume restores this browser's explicitly saved demo session only.</p>
          <Link className="button-primary" to="/app/practice/session">Continue session</Link>
        </article>
        <article className="card">
          <h2>Start a new sample set</h2>
          <p>Choose the available illustrative question pool and filters.</p>
          <Link className="button-secondary" to="/app/practice/setup">Practice setup</Link>
        </article>
      </div>
      <section className="card section-block">
        <h2>Bookmarks</h2>
        <p>Bookmarks in this demo session are stored with that session in browser storage only.</p>
        {loading ? (
          <p role="status">Loading this browser’s demo bookmarks…</p>
        ) : storageError ? (
          <p className="form-errors" role="alert">{storageError}</p>
        ) : bookmarks.length ? (
          <ul>
            {bookmarks.map((id) => {
              const question = demoQuestions.find((item) => item.id === id);
              return question ? (
                <li key={id}>{question.domain}: {question.stem}</li>
              ) : null;
            })}
          </ul>
        ) : (
          <p className="empty-state">No bookmarked sample questions in this browser.</p>
        )}
        {import.meta.env.DEV && (
          <Link to="/app/prototype/reset">Open the development-only prototype reset page</Link>
        )}
      </section>
    </>
  );
}

function ProgressPage() {
  return (
    <>
      <DemoNotice />
      <p className="eyebrow">Synthetic statistics only</p>
      <h1>Progress</h1>
      <div className="notice" role="note">
        This prototype contains no actual learner performance and makes no readiness prediction.
      </div>
      <section className="progress-grid section-block">
        <article className="card">
          <h2>First-seen performance</h2>
          <p className="metric">72% <span>· 25 sample answers</span></p>
          <p>Each question counted once, at its first submitted response.</p>
          <div className="progress-track" role="img" aria-label="Synthetic first-seen performance: 72 percent">
            <span style={{ width: "72%" }} />
          </div>
        </article>
        <article className="card">
          <h2>Repeated-question performance</h2>
          <p className="metric">86% <span>· 14 repeat answers</span></p>
          <p>Repeat responses are separate from first-seen accuracy.</p>
          <div className="progress-track" role="img" aria-label="Synthetic repeat performance: 86 percent">
            <span style={{ width: "86%" }} />
          </div>
        </article>
      </section>
      <section className="card section-block">
        <h2>Domain sample coverage</h2>
        <ul className="domain-bars">
          <li><span>Security and Risk Management · 8 / 12</span><span className="progress-track"><span style={{ width: "67%" }} /></span></li>
          <li><span>Asset Security · 5 / 10</span><span className="progress-track"><span style={{ width: "50%" }} /></span></li>
          <li><span>Security Architecture · 2 / 10</span><span className="progress-track"><span style={{ width: "20%" }} /></span></li>
        </ul>
      </section>
      <section className="empty-state section-block" aria-labelledby="empty-progress-title">
        <h2 id="empty-progress-title">No data for this date range</h2>
        <p>Example empty state. A real report would need sufficient submitted answers.</p>
        <Link to="/app/practice/setup">Try illustrative practice</Link>
      </section>
    </>
  );
}

function AccountPage() {
  return (
    <>
      <DemoNotice />
      <p className="eyebrow">Account and access preview</p>
      <h1>Access management</h1>
      <p className="intro">No signed-in account exists. All displayed dates are synthetic.</p>
      <div className="access-grid">
        {Object.entries(demoEntitlements).map(([name, entitlement]) => (
          <article className="card" key={name}>
            <AccessLine certification={name} entitlement={entitlement} />
            <p>Purchase history preview · no payment provider or purchase is connected.</p>
            <button className="button-secondary" type="button" disabled>
              Extend Standard unavailable in prototype
            </button>
            <button className="button-secondary" type="button" disabled>
              Add Pro unavailable in prototype
            </button>
          </article>
        ))}
      </div>
      <section className="card section-block">
        <p className="eyebrow">Expired access example</p>
        <h2>Sample certification · Standard expired 30 Oct 2026</h2>
        <p>New protected questions and attempts would be blocked; account and history would remain.</p>
        <p>Historical explanation access is unresolved and is not simulated as a policy here.</p>
      </section>
      <section className="card-grid section-block">
        <article className="card">
          <h2>Device-management preview</h2>
          <p>Demo browser · this page · no real device registration or session revocation.</p>
          <button className="button-secondary" type="button" disabled>
            Manage devices unavailable
          </button>
        </article>
        <article className="card">
          <h2>Privacy and preferences</h2>
          <p>No analytics are transmitted. No personal data is collected.</p>
          <button className="button-secondary" type="button" disabled>
            Preferences unavailable
          </button>
        </article>
      </section>
      {import.meta.env.DEV && (
        <section className="card section-block">
          <p className="eyebrow">Development-only</p>
          <Link to="/app/prototype/reset">Open prototype reset</Link>
        </section>
      )}
    </>
  );
}

function PrototypeResetPage() {
  const [message, setMessage] = useState("");

  if (!import.meta.env.DEV) {
    return (
      <section className="empty-state">
        <p className="eyebrow">Prototype reset</p>
        <h1>Development-only controls</h1>
        <p>Reset controls are available only in the local development preview.</p>
        <Link to="/app/account">Return to account preview</Link>
      </section>
    );
  }

  return (
    <section className="card">
      <p className="eyebrow">Development-only prototype control</p>
      <h1>Prototype reset</h1>
      <p>
        This clears the saved illustrative practice session from this browser
        only. It does not affect an account or server data. The action cannot
        be undone.
      </p>
      <button
        className="button-secondary"
        type="button"
        onClick={() => {
          try {
            window.localStorage.removeItem(practiceDemoStorageKey);
            setMessage("Demo practice data cleared from this browser.");
          } catch (error) {
            setMessage(
              error instanceof Error
                ? `Could not clear browser demo data: ${error.message}`
                : "Could not clear browser demo data.",
            );
          }
        }}
      >
        Reset demo practice data
      </button>
      {message && <p role="status" aria-live="polite">{message}</p>}
      <p><Link to="/app/account">Return to account preview</Link></p>
    </section>
  );
}

function NotFoundState() {
  return (
    <section className="empty-state">
      <h1>Preview not available</h1>
      <p>This route is not part of the Milestone 1 prototype.</p>
      <Link to="/app">Return to learner home</Link>
    </section>
  );
}

export default function Learner() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, "") || "/app";
  const segments = path.split("/").filter(Boolean);
  const examPath = segments[1] === "exams" && segments[2];
  const examSection = examPath ? segments.slice(3).join("/") : "";
  const supported =
    path === "/app" ||
    path === "/app/exams" ||
    path === "/app/practice" ||
    path === "/app/practice/setup" ||
    path === "/app/practice/session" ||
    path === "/app/progress" ||
    path === "/app/account" ||
    path === "/app/prototype/reset" ||
    (examPath && ["cissp", "cism"].includes(examPath.toLowerCase()));

  return (
    <WorkspaceShell
      title="Learner preview · synthetic data"
      mobileNavigation="learner"
      links={learnerLinks}
    >
      {!supported ? (
        <NotFoundState />
      ) : path === "/app" ? (
        <LearnerHome />
      ) : path === "/app/exams" ? (
        <ExamList />
      ) : path === "/app/practice/session" ? (
        <PracticeDemo />
      ) : path === "/app/practice/setup" ? (
        <PracticeSetup certification="CISSP" />
      ) : path === "/app/practice" ? (
        <PracticeHub />
      ) : path === "/app/progress" ? (
        <ProgressPage />
      ) : path === "/app/account" ? (
        <AccountPage />
      ) : path === "/app/prototype/reset" ? (
        <PrototypeResetPage />
      ) : examPath ? (
        <ExamWorkspace certification={examPath} section={examSection} />
      ) : (
        <NotFoundState />
      )}
    </WorkspaceShell>
  );
}
