export interface AdminGateBindings {
  ADMIN_TESTER_IPS?: string;
  ADMIN_TESTER_LOCAL?: string;
}

const adminSurfacePrefixes = ["/admin", "/api/admin"] as const;

export function isAdminSurfacePath(pathname: string): boolean {
  return adminSurfacePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isLoopbackRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function gateResponse(status: 403 | 503): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * Deny-by-default tester gate for every admin page and API. An empty allowlist
 * closes the admin surface completely; only an explicit local-only opt-in lets
 * a loopback request through when the platform did not supply a client IP.
 */
export function adminTesterGate(
  request: Request,
  bindings: AdminGateBindings,
): Response | null {
  const allowedIps = bindings.ADMIN_TESTER_IPS?.split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (!allowedIps?.length) return gateResponse(503);

  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  if (clientIp) {
    return allowedIps.includes(clientIp) ? null : gateResponse(403);
  }
  if (bindings.ADMIN_TESTER_LOCAL === "true" && isLoopbackRequest(request)) {
    return null;
  }
  return gateResponse(403);
}
