import { Link } from "react-router";
import type { Route } from "./+types/learner-timed-mock";
import { LearnerTimedMock } from "../components/learner-timed-mock";
import { WorkspaceShell } from "../components/workspace-shell";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Timed mock | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

const links = [
  { label: "Dashboard", to: "/app/home" },
  { label: "Protected practice", to: "/app/practice/live" },
  { label: "Timed mock", to: "/app/mock/live" },
  { label: "Synthetic practice demo", to: "/app/practice" },
];

export default function LearnerTimedMockRoute() {
  return (
    <WorkspaceShell
      title="Timed CertPath practice"
      mobileNavigation="learner"
      links={links}
    >
      <LearnerTimedMock />
      <p className="privacy-note">
        This protected mock uses server-saved answers and a server-enforced
        deadline. It is not an official certification exam.
        {" "}
        <Link to="/app/practice/live">Open untimed practice</Link>.
      </p>
    </WorkspaceShell>
  );
}
