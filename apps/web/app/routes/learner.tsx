import type { Route } from "./+types/learner";
import { WorkspaceShell } from "../components/workspace-shell";

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Learner workspace preview | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function Learner() {
  return (
    <WorkspaceShell
      title="Learner workspace preview"
      mobileNavigation="learner"
      links={[
        { label: "Home", to: "/app" },
        { label: "My Exams", to: "/app/exams" },
        { label: "Practice", to: "/app/practice" },
        { label: "Progress", to: "/app/progress" },
        { label: "Account", to: "/app/account" },
      ]}
    >
      <h1>Learner workspace</h1>
      <div className="notice" role="note">
        <strong>Foundation placeholder.</strong> Authentication, exam access,
        learner data, practice, and saved progress are not implemented.
      </div>
    </WorkspaceShell>
  );
}
