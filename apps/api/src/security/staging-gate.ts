export interface StagingGateBindings {
  STAGING_TESTER_IPS?: string;
}

export function isStagingLocalTestOrigin(
  value: string | undefined,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === "https:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function stagingTesterGate(
  request: { headers: Headers },
  bindings: StagingGateBindings,
): Response | null {
  const allowedIps = bindings.STAGING_TESTER_IPS?.split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (!allowedIps?.length) {
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: 503,
    });
  }
  const clientIp = request.headers.get("cf-connecting-ip");
  if (!clientIp || !allowedIps.includes(clientIp)) {
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: 403,
    });
  }
  return null;
}
