export interface StagingGateBindings {
  STAGING_TESTER_IPS?: string;
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
