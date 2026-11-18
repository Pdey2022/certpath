import type { Route } from "./+types/learner-sign-in-link";
import { LearnerSignInLinkConfirm } from "../components/learner-sign-in-link";
import { PublicLayout } from "../components/public-layout";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Confirm sign-in | CertPath" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function LearnerSignInLinkRoute() {
  return (
    <PublicLayout>
      <LearnerSignInLinkConfirm />
    </PublicLayout>
  );
}
