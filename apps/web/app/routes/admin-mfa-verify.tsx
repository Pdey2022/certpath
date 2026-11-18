import type { Route } from "./+types/admin-mfa-verify";
import { StaffMfaVerify } from "../components/staff-mfa";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Second factor | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function AdminMfaVerifyRoute() {
  return <StaffMfaVerify />;
}
