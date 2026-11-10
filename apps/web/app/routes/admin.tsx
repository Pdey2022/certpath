import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/admin";
import { WorkspaceShell } from "../components/workspace-shell";

type DemoRole = "global-admin" | "manager";
type QuestionStatus = "Draft" | "In review" | "Published";

interface QuestionDraft {
  stem: string;
  options: string[];
  correctIndex: number;
  explanations: string[];
  domain: string;
  difficulty: string;
  status: QuestionStatus;
}

const initialDraft: QuestionDraft = {
  stem: "Which action best supports accountable risk treatment?",
  options: [
    "Record the risk owner, decision, and review date",
    "Leave the decision undocumented",
    "Apply a control without checking the risk",
    "Share sensitive data to speed up approval",
  ],
  correctIndex: 0,
  explanations: [
    "A named owner and review date make the treatment decision accountable.",
    "An undocumented decision cannot be reliably reviewed.",
    "Controls should be selected with reference to the assessed risk.",
    "Sharing sensitive data does not establish accountability.",
  ],
  domain: "Security and Risk Management",
  difficulty: "Foundational",
  status: "Draft",
};

const allAdminLinks = [
  { label: "Overview", to: "/admin" },
  { label: "Certifications", to: "/admin/certifications" },
  { label: "Question bank", to: "/admin/questions" },
  { label: "Reviews", to: "/admin/reviews" },
  { label: "Exam profiles", to: "/admin/profiles" },
  { label: "Pro settings", to: "/admin/pro" },
  { label: "Products & prices", to: "/admin/products" },
  { label: "Customers", to: "/admin/customers" },
  { label: "Payments", to: "/admin/payments" },
  { label: "Support", to: "/admin/support" },
  { label: "Reports", to: "/admin/reports" },
  { label: "Staff & audit", to: "/admin/staff" },
  { label: "Security", to: "/admin/security" },
  { label: "Settings", to: "/admin/settings" },
];

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Admin workspace preview | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

function DevRolePanel({ role, onChange }: { role: DemoRole; onChange: (role: DemoRole) => void }) {
  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <aside className="demo-panel admin-role-panel" aria-labelledby="admin-demo-title">
      <p className="eyebrow">Development-only demo control</p>
      <h2 id="admin-demo-title">Preview role selector</h2>
      <p>
        This selector changes presentation only. It is not authentication, authorization, a staff
        account, or a security boundary.
      </p>
      <div className="button-row">
        <button
          className="button-secondary"
          type="button"
          aria-pressed={role === "global-admin"}
          onClick={() => onChange("global-admin")}
        >
          Preview Global Admin
        </button>
        <button
          className="button-secondary"
          type="button"
          aria-pressed={role === "manager"}
          onClick={() => onChange("manager")}
        >
          Preview Manager · CISSP assigned
        </button>
      </div>
    </aside>
  );
}

function AdminOverview({ role }: { role: DemoRole }) {
  const roleQuery = role === "manager" ? "?demoRole=manager" : "";
  return (
    <>
      <p className="eyebrow">Synthetic administrative preview</p>
      <h1>{role === "global-admin" ? "Global Admin overview" : "Manager content overview"}</h1>
      <div className="prototype-notice" role="note">
        All records and counts are illustrative synthetic fixtures. No staff sign-in, customer data,
        database writes or production permissions exist.
      </div>
      <div className="stats-grid section-block">
        <article className="card"><p className="eyebrow">Certification modules</p><p className="metric">2 <span>synthetic</span></p></article>
        <article className="card"><p className="eyebrow">Questions in draft</p><p className="metric">4 <span>synthetic</span></p></article>
        <article className="card"><p className="eyebrow">Awaiting review</p><p className="metric">1 <span>synthetic</span></p></article>
        {role === "global-admin" && (
          <article className="card"><p className="eyebrow">Commercial data</p><p className="metric">Not connected</p></article>
        )}
      </div>
      <div className="feature-grid section-block">
        <article className="card">
          <h2>Question editor</h2>
          <p>Review options, correct answer, explanations, domain, difficulty and editorial status.</p>
          <Link className="button-primary" to={`/admin/questions${roleQuery}`}>Open editor preview</Link>
        </article>
        <article className="card">
          <h2>Import validation</h2>
          <p>Inspect a synthetic CSV preview. No file is uploaded or published.</p>
          <Link className="button-secondary" to={`/admin/import${roleQuery}`}>Preview import</Link>
        </article>
        <article className="card">
          <h2>Revision history</h2>
          <p>See sample revision actors, state changes and reasons.</p>
          <Link className="button-secondary" to={`/admin/revisions${roleQuery}`}>View revisions</Link>
        </article>
      </div>
    </>
  );
}

function CertificationModules({ role }: { role: DemoRole }) {
  const roleQuery = role === "manager" ? "?demoRole=manager" : "";
  return (
    <>
      <p className="eyebrow">Content tools · synthetic modules</p>
      <h1>Certifications and exam modules</h1>
      <p>
        {role === "manager"
          ? "Manager preview is limited to the assigned CISSP certification."
          : "Global Admin preview can inspect the synthetic certification roots."}
      </p>
      <div className="table-scroll">
        <table>
          <caption>Synthetic certification modules</caption>
          <thead><tr><th scope="col">Certification</th><th scope="col">Version</th><th scope="col">Modules</th><th scope="col">State</th><th scope="col">Action</th></tr></thead>
          <tbody>
            <tr><th scope="row">CISSP</th><td>Sample 2026</td><td>8 domains · 24 topics</td><td>Draft</td><td><Link to={`/admin/modules${roleQuery}`}>Manage modules</Link> · <Link to={`/admin/questions${roleQuery}`}>Edit content</Link></td></tr>
            {role === "global-admin" && <tr><th scope="row">CISM</th><td>Sample 2026</td><td>4 domains · 12 topics</td><td>In review</td><td><Link to="/admin/questions">Preview content</Link></td></tr>}
          </tbody>
        </table>
      </div>
      {role === "global-admin" ? (
        <button className="button-secondary" type="button" disabled>
          Create certification root unavailable in prototype
        </button>
      ) : (
        <p className="muted">Certification roots and assignments are Global Admin responsibilities.</p>
      )}
    </>
  );
}

function ModuleManagement({ role }: { role: DemoRole }) {
  const [modules, setModules] = useState([
    "Security and Risk Management",
    "Asset Security",
    "Security Architecture",
  ]);
  const [newModule, setNewModule] = useState("");
  const [message, setMessage] = useState("");
  const roleQuery = role === "manager" ? "?demoRole=manager" : "";

  function addModule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = newModule.trim();
    if (!value) {
      setMessage("Enter a module name before adding it.");
      return;
    }
    if (modules.some((module) => module.toLowerCase() === value.toLowerCase())) {
      setMessage("That sample module already exists.");
      return;
    }
    setModules((current) => [...current, value]);
    setNewModule("");
    setMessage("Module added to this page preview only; no database was updated.");
  }

  return (
    <>
      <p className="eyebrow">Certification modules · CISSP assignment preview</p>
      <h1>Manage exam modules</h1>
      <p className="prototype-notice" role="note">
        Module changes are local component state only. The sample syllabus version remains 2026.
      </p>
      <ol className="module-list">
        {modules.map((module, index) => (
          <li key={module}>
            <span>{module}</span>
            <span className="muted">Module {index + 1} · sample topics configured</span>
          </li>
        ))}
      </ol>
      <form className="button-row module-form" onSubmit={addModule}>
        <label>
          New sample module
          <input value={newModule} onChange={(event) => setNewModule(event.target.value)} />
        </label>
        <button className="button-primary" type="submit">Add module preview</button>
      </form>
      {message && <p role="status" aria-live="polite">{message}</p>}
      <Link to={`/admin/questions${roleQuery}`}>Continue to question editing</Link>
    </>
  );
}

function QuestionEditor() {
  const [draft, setDraft] = useState(initialDraft);
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState("");

  const errors = [
    !draft.stem.trim() && "Question stem is required.",
    draft.options.some((option) => !option.trim()) && "Every answer option needs text.",
    draft.explanations.some((explanation) => !explanation.trim()) &&
      "Every option needs an explanation.",
    !draft.domain && "Choose a domain.",
  ].filter(Boolean) as string[];

  function updateOption(index: number, value: string) {
    setDraft((current) => ({
      ...current,
      options: current.options.map((option, optionIndex) =>
        optionIndex === index ? value : option,
      ),
    }));
  }

  function updateExplanation(index: number, value: string) {
    setDraft((current) => ({
      ...current,
      explanations: current.explanations.map((explanation, explanationIndex) =>
        explanationIndex === index ? value : explanation,
      ),
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    setMessage(
      errors.length
        ? "Review the validation errors before continuing."
        : "Validation passed. This draft changed only in this page preview; no database was updated.",
    );
  }

  return (
    <>
      <p className="eyebrow">Question bank · synthetic sample</p>
      <h1>Question editor</h1>
      <p className="prototype-notice" role="note">
        Local component state only. Saving, review and publication do not mutate a database.
      </p>
      {attempted && errors.length > 0 && (
        <div className="form-errors" role="alert" aria-labelledby="error-summary-title">
          <h2 id="error-summary-title">Fix these items</h2>
          <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      )}
      <form className="editor-form" onSubmit={submit} noValidate>
        <label>
          Question stem
          <textarea
            required
            rows={3}
            value={draft.stem}
            aria-invalid={attempted && !draft.stem.trim()}
            onChange={(event) => setDraft({ ...draft, stem: event.target.value })}
          />
        </label>
        <fieldset>
          <legend>Answer options and correct answer</legend>
          {draft.options.map((option, index) => (
            <div className="option-editor" key={index}>
              <label>
                <span>Option {String.fromCharCode(65 + index)}</span>
                <input
                  type="radio"
                  name="correct-answer"
                  aria-label={`Mark option ${String.fromCharCode(65 + index)} as correct`}
                  checked={draft.correctIndex === index}
                  onChange={() => setDraft({ ...draft, correctIndex: index })}
                />
                <span>Correct answer</span>
              </label>
              <textarea
                rows={2}
                aria-label={`Option ${String.fromCharCode(65 + index)} text`}
                value={option}
                aria-invalid={attempted && !option.trim()}
                onChange={(event) => updateOption(index, event.target.value)}
              />
              <label>
                Explanation for option {String.fromCharCode(65 + index)}
                <textarea
                  rows={2}
                  value={draft.explanations[index]}
                  aria-invalid={attempted && !draft.explanations[index].trim()}
                  onChange={(event) => updateExplanation(index, event.target.value)}
                />
              </label>
            </div>
          ))}
        </fieldset>
        <div className="form-grid">
          <label>
            Domain
            <select value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })}>
              <option value="">Select a domain</option>
              <option>Security and Risk Management</option>
              <option>Asset Security</option>
              <option>Security Architecture</option>
            </select>
          </label>
          <label>
            Difficulty
            <select value={draft.difficulty} onChange={(event) => setDraft({ ...draft, difficulty: event.target.value })}>
              <option>Foundational</option><option>Intermediate</option><option>Advanced</option>
            </select>
          </label>
          <label>
            Editorial state
            <select
              value={draft.status}
              onChange={(event) => setDraft({ ...draft, status: event.target.value as QuestionStatus })}
            >
              <option>Draft</option><option>In review</option><option>Published</option>
            </select>
          </label>
        </div>
        <div className="button-row">
          <button className="button-primary" type="submit">Validate preview</button>
          <button
            className="button-secondary"
            type="button"
            onClick={() => {
              setDraft(initialDraft);
              setAttempted(false);
              setMessage("Synthetic sample restored.");
            }}
          >
            Reset sample
          </button>
        </div>
        {message && <p role="status" aria-live="polite">{message}</p>}
      </form>
    </>
  );
}

function ImportPreview() {
  const [csv, setCsv] = useState(
    "stem,option_a,option_b,correct,domain,difficulty,status\n\"Document the risk owner\", \"Record the owner\", \"Leave it blank\", A, Governance, Foundational, draft",
  );
  const [previewed, setPreviewed] = useState(false);
  const rows = csv.split(/\r?\n/).filter((line) => line.trim());
  const valid = rows.length > 1 && rows[0].startsWith("stem,") && rows[1].split(",").length >= 7;

  return (
    <>
      <p className="eyebrow">Import preview · synthetic CSV</p>
      <h1>Validate an import</h1>
      <p className="prototype-notice" role="note">
        This preview parses text in this page only. Nothing is uploaded or published.
      </p>
      <label className="import-input">
        CSV sample
        <textarea rows={7} value={csv} onChange={(event) => { setCsv(event.target.value); setPreviewed(false); }} />
      </label>
      <button className="button-primary" type="button" onClick={() => setPreviewed(true)}>
        Validate import preview
      </button>
      {previewed && (
        <section className={valid ? "notice" : "form-errors"} role={valid ? "status" : "alert"}>
          <h2>{valid ? "Preview ready" : "Import validation found an issue"}</h2>
          <p>{valid ? `${rows.length - 1} synthetic row; status remains draft.` : "Expected a header beginning with stem, and at least seven fields in a data row."}</p>
          {valid && <pre className="import-row">{rows[1]}</pre>}
          <p>No database changes are made by this prototype.</p>
        </section>
      )}
    </>
  );
}

function RevisionHistory() {
  return (
    <>
      <p className="eyebrow">Synthetic revision history</p>
      <h1>Question revisions</h1>
      <div className="table-scroll">
        <table>
          <caption>Illustrative revision audit trail</caption>
          <thead><tr><th scope="col">Revision</th><th scope="col">State</th><th scope="col">Changed by</th><th scope="col">Reason</th></tr></thead>
          <tbody>
            <tr><th scope="row">Q-SAMPLE-01 · v3</th><td>In review</td><td>Manager preview · CISSP</td><td>Clarified distractor explanation</td></tr>
            <tr><th scope="row">Q-SAMPLE-01 · v2</th><td>Published (sample)</td><td>Global Admin preview</td><td>Approved for illustrative display</td></tr>
            <tr><th scope="row">Q-SAMPLE-01 · v1</th><td>Draft</td><td>Manager preview · CISSP</td><td>Initial synthetic revision</td></tr>
          </tbody>
        </table>
      </div>
      <p>Sample history is immutable text in the prototype; no audit record is written.</p>
    </>
  );
}

function AdminSection({ path, role }: { path: string; role: DemoRole }) {
  const globalOnly = ["products", "customers", "payments", "support", "staff", "security", "settings"];
  const slug = path.replace(/^\/admin\/?/, "").split("/")[0];
  if (role === "manager" && globalOnly.includes(slug)) {
    return (
      <section className="permission-preview">
        <p className="eyebrow">Permission-denied example</p>
        <h1>Not available in the Manager preview</h1>
        <p>
          The product contract reserves finance, unrestricted customer data, staff and security
          settings for Global Admin. This is a presentation example only, not server-side enforcement.
        </p>
        <Link to="/admin/questions">Return to assigned CISSP content</Link>
      </section>
    );
  }

  if (path === "/admin" || path === "/admin/") return <AdminOverview role={role} />;
  if (slug === "certifications") return <CertificationModules role={role} />;
  if (slug === "questions") return <QuestionEditor />;
  if (slug === "import") return <ImportPreview />;
  if (slug === "revisions") return <RevisionHistory />;
  if (slug === "reviews") return <EmptyPreview title="Content reviews" description="No synthetic review queue items are configured for this screen." />;
  if (slug === "profiles") return <EmptyPreview title="Exam profiles" description="Sample profile preview only. Timers, navigation rules and profiles are not implemented." />;
  if (slug === "pro") return <EmptyPreview title="Pro settings" description="Profile settings preview only. No adaptive engine or readiness prediction exists." />;
  if (slug === "reports") return <EmptyPreview title="Quality reports" description="No real content or learner quality data is available." />;
  if (globalOnly.includes(slug)) {
    if (slug === "security") {
      return <EmptyPreview title="Security controls preview" description="Global Admin area preview for MFA policy, session controls and reviewed alerts. No security settings or secrets are connected." />;
    }
    if (slug === "settings") {
      return <EmptyPreview title="Settings preview" description="Global Admin configuration preview. Integrations, provider credentials and production settings are not connected." />;
    }
    return <EmptyPreview title={allAdminLinks.find((link) => link.to.endsWith(slug))?.label ?? "Admin preview"} description="Commercial, account and staff data are not connected in this prototype." />;
  }
  if (slug === "modules") return <ModuleManagement role={role} />;
  return <EmptyPreview title="Admin page unavailable" description="This route is outside the Milestone 1 preview." />;
}

function EmptyPreview({ title, description }: { title: string; description: string }) {
  return (
    <section className="empty-state">
      <p className="eyebrow">Prototype preview</p>
      <h1>{title}</h1>
      <p>{description}</p>
      <p>No production data is loaded.</p>
    </section>
  );
}

export default function Admin() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(search);
  const role: DemoRole = query.get("demoRole") === "manager" ? "manager" : "global-admin";
  const links =
    role === "global-admin"
      ? allAdminLinks
      : allAdminLinks.filter(
          (link) =>
            !["/admin/products", "/admin/customers", "/admin/payments", "/admin/support", "/admin/staff", "/admin/security", "/admin/settings"].includes(link.to),
        );

  function changeRole(next: DemoRole) {
    const params = new URLSearchParams(search);
    if (next === "manager") {
      params.set("demoRole", "manager");
    } else {
      params.delete("demoRole");
    }
    const queryString = params.toString();
    navigate(`${pathname}${queryString ? `?${queryString}` : ""}`);
  }

  return (
    <WorkspaceShell
      title={`Admin preview · ${role === "global-admin" ? "Global Admin" : "Manager"} · synthetic`}
      mobileNavigation="admin"
      links={links.map((link) => ({
        ...link,
        to: role === "manager" ? `${link.to}?demoRole=manager` : link.to,
      }))}
    >
      <div className="admin-content">
        <DevRolePanel role={role} onChange={changeRole} />
        <AdminSection path={pathname} role={role} />
        <p className="prototype-notice section-block" role="note">
          Preview role: {role === "global-admin" ? "Global Admin" : "Manager · CISSP assigned"}. This is
          not authentication or production authorization.
        </p>
      </div>
    </WorkspaceShell>
  );
}
