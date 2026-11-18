import type { Route } from "./+types/admin-sign-in";
import { StaffSignIn } from "../components/staff-sign-in";

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Staff sign in | CertPath" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function AdminSignInRoute() {
  return <StaffSignIn />;
}
