import { Link } from "react-router";

export function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="public-header">
        <div className="public-header-inner">
          <Link className="brand" to="/">
            Exam Prep
          </Link>
          <nav className="public-nav" aria-label="Public navigation">
            <Link to="/exams">Exams</Link>
            <Link to="/sign-in">Learner sign in</Link>
            <Link to="/app">Learner preview</Link>
          </nav>
        </div>
      </header>
      {children}
      <footer className="public-footer">
        <div className="public-footer-inner">
          <p>
            Exam Prep is a working label. Certification listings and content
            require review before publication.
          </p>
        </div>
      </footer>
    </>
  );
}
