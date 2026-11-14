export const publicReleaseExcludedPaths = [
  "/api",
  "/app",
  "/admin",
  "/sign-in",
  "/verify-email",
  "/recover-password",
  "/reset-password",
  "/local-inbox",
] as const;

/**
 * The private pilot keeps the learner app and the Google routes, and closes the
 * password, Cognito, admin, and email paths it does not use.
 */
export const pilotExcludedPaths = [
  "/api/auth/local",
  "/api/auth/staging",
  "/api/auth/cognito",
  "/admin",
  "/verify-email",
  "/recover-password",
  "/reset-password",
  "/local-inbox",
] as const;

export function pathMatchesPrefix(
  pathname: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
