import type { Route } from "./+types/local-inbox";
import { LearnerLocalInboxRoute } from "../components/learner-email-actions";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Synthetic local inbox | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default LearnerLocalInboxRoute;
