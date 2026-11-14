/**
 * The public release is a separate Workers Free Worker that serves the landing
 * page and exam catalogue only. Sign-in, registration, checkout, admin, and the
 * learner APIs stay out of it.
 */
export const isPublicReleaseSite =
  typeof import.meta.env !== "undefined" &&
  import.meta.env.VITE_CERTPATH_PUBLIC_RELEASE === "true";

export const liveDemoUrl = "https://certpath-ui-preview.certpath.workers.dev";

export const publicReleaseRoutes = ["/", "/exams"] as const;
