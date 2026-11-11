import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("exams", "routes/exams.tsx"),
  route("app/home", "routes/learner-dashboard.tsx"),
  route("app/practice/live", "routes/learner-practice.tsx"),
  route("app/mock/live", "routes/learner-timed-mock.tsx"),
  route("app/*", "routes/learner.tsx"),
  route("admin/question-editor", "routes/admin-question-editor.tsx"),
  route("admin/*", "routes/admin.tsx"),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
] satisfies RouteConfig;
