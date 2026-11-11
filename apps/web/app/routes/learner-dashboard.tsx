import type { Route } from "./+types/learner-dashboard";
import { LearnerDashboard } from "../components/learner-dashboard";
import { WorkspaceShell } from "../components/workspace-shell";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Learning dashboard | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

const links = [
  { label: "Dashboard", to: "/app/home" },
  { label: "Protected practice", to: "/app/practice/live" },
  { label: "Timed mock", to: "/app/mock/live" },
  { label: "Synthetic practice demo", to: "/app/practice" },
];

export default function LearnerDashboardRoute() {
  return (
    <WorkspaceShell
      title="Learner dashboard"
      mobileNavigation="learner"
      links={links}
    >
      <LearnerDashboard />
    </WorkspaceShell>
  );
}
