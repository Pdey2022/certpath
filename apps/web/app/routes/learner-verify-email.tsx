import type { Route } from "./+types/learner-verify-email";
import { LearnerVerifyEmailRoute } from "../components/learner-email-actions";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Verify learner email | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default LearnerVerifyEmailRoute;
