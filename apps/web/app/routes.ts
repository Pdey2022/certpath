import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/learner-sign-in.tsx"),
  route("sign-in/link", "routes/learner-sign-in-link.tsx"),
  route("verify-email", "routes/learner-verify-email.tsx"),
  route("recover-password", "routes/learner-password-recovery.tsx"),
  route("reset-password", "routes/learner-password-reset.tsx"),
  route("local-inbox", "routes/local-inbox.tsx"),
  route("exams", "routes/exams.tsx"),
  route("app/home", "routes/learner-dashboard.tsx"),
  route("app/practice/live", "routes/learner-practice.tsx"),
  route("app/mock/live", "routes/learner-timed-mock.tsx"),
  route("app/*", "routes/learner.tsx"),
  route("admin/sign-in", "routes/admin-sign-in.tsx"),
  route("admin/question-editor", "routes/admin-question-editor.tsx"),
  route("admin/*", "routes/admin.tsx"),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
] satisfies RouteConfig;
