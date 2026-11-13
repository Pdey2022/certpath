import type { Route } from "./+types/learner-password-recovery";
import { LearnerRecoveryRoute } from "../components/learner-email-actions";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Reset learner password | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default LearnerRecoveryRoute;
