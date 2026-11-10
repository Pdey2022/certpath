import type { Route } from "./+types/admin";
import { WorkspaceShell } from "../components/workspace-shell";

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Admin workspace preview | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function Admin() {
  return (
    <WorkspaceShell
      title="Admin workspace preview"
      mobileNavigation="admin"
      links={[
        { label: "Overview", to: "/admin" },
        { label: "Certifications", to: "/admin/certifications" },
        { label: "Question bank", to: "/admin/questions" },
        { label: "Reviews", to: "/admin/reviews" },
        { label: "Exam profiles", to: "/admin/profiles" },
        { label: "Pro settings", to: "/admin/pro" },
        { label: "Products & prices", to: "/admin/products" },
        { label: "Customers", to: "/admin/customers" },
        { label: "Payments", to: "/admin/payments" },
        { label: "Support", to: "/admin/support" },
        { label: "Reports", to: "/admin/reports" },
        { label: "Staff & audit", to: "/admin/staff" },
        { label: "Settings", to: "/admin/settings" },
      ]}
    >
      <h1>Admin workspace</h1>
      <div className="notice" role="note">
        <strong>Foundation placeholder.</strong> This shell has no signed-in
        staff identity, customer data, or permission enforcement. The product
        defines exactly two staff roles: Global Admin and exam-scoped Manager.
      </div>
    </WorkspaceShell>
  );
}
