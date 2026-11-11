import { Link } from "react-router";
import type { Route } from "./+types/learner-practice";
import { LearnerPractice } from "../components/learner-practice";
import { WorkspaceShell } from "../components/workspace-shell";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Protected practice | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

const links = [
  { label: "Home preview", to: "/app" },
  { label: "Protected practice", to: "/app/practice/live" },
  { label: "Synthetic practice demo", to: "/app/practice" },
];

export default function LearnerPracticeRoute() {
  return (
    <WorkspaceShell
      title="Protected learner practice"
      mobileNavigation="learner"
      links={links}
    >
      <LearnerPractice />
      <p className="privacy-note">
        This protected route is separate from the{" "}
        <Link to="/app/practice">synthetic browser-storage prototype</Link>.
      </p>
    </WorkspaceShell>
  );
}
