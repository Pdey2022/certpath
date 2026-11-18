import type { Route } from "./+types/admin-mfa-enrol";
import { StaffMfaEnrol } from "../components/staff-mfa";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Enrol a second factor | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function AdminMfaEnrolRoute() {
  return <StaffMfaEnrol />;
}
