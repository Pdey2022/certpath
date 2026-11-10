import { Link, NavLink } from "react-router";

export interface WorkspaceLink {
  label: string;
  to: string;
}

export function WorkspaceShell({
  title,
  mobileNavigation,
  links,
  children,
}: {
  title: string;
  mobileNavigation: "learner" | "admin";
  links: WorkspaceLink[];
  children: React.ReactNode;
}) {
  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-main">
        Skip to workspace
      </a>
      <header className="workspace-header">
        <Link className="brand" to="/">
          Exam Prep
        </Link>
        <p className="workspace-title">{title}</p>
      </header>
      <div className="workspace-layout">
        <aside className="workspace-sidebar" aria-label={`${title} navigation`}>
          <nav className="workspace-nav" aria-label={`${title} sections`}>
            {links.map((link) => (
              <NavLink key={link.to} to={link.to} end>
                {link.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <nav
          className={`workspace-nav workspace-nav-mobile workspace-nav-mobile--${mobileNavigation}`}
          aria-label={
            mobileNavigation === "admin"
              ? `${title} sections, scroll horizontally for more`
              : `${title} sections`
          }
        >
          {links.map((link) => (
            <NavLink key={link.to} to={link.to} end>
              {link.label}
            </NavLink>
          ))}
        </nav>
        <main id="workspace-main" className="workspace-content">
          {children}
        </main>
      </div>
    </div>
  );
}
