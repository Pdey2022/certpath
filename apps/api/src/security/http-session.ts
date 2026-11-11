const SESSION_COOKIE = "certpath_session";

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="),
      (character) => character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32) return null;
    return base64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function sessionCookieToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(SESSION_COOKIE.length + 1);
  return decodeBase64Url(value) ? value : null;
}

export async function sessionDigest(rawToken: string): Promise<string> {
  const bytes = decodeBase64Url(rawToken);
  if (!bytes) throw new Error("Invalid opaque session token");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCsrfToken(
  origin: string,
  tokenDigest: string,
  secret: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `certpath-csrf-v1\n${origin}\n${tokenDigest}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(new TextEncoder().encode(payload)),
    ),
  );
  return `v1.${base64Url(signature)}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
