export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface SignLambdaRequestOptions {
  body: string;
  credentials: TemporaryCredentials;
  now?: Date;
  region: string;
  url: URL;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacSha256(
  key: ArrayBuffer | string,
  value: string,
): Promise<ArrayBuffer> {
  const keyData = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

export async function signLambdaRequest(
  options: SignLambdaRequestOptions,
): Promise<Headers> {
  const { body, credentials, region, url } = options;
  const amzDate = (options.now ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const signedHeaders: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": credentials.sessionToken,
  };
  const names = Object.keys(signedHeaders).sort();
  const canonicalRequest = [
    "POST",
    url.pathname,
    "",
    `${names.map((name) => `${name}:${signedHeaders[name]}`).join("\n")}\n`,
    names.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/lambda/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key = await hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  for (const part of [region, "lambda", "aws4_request"]) {
    key = await hmacSha256(key, part);
  }
  const signature = toHex(await hmacSha256(key, stringToSign));

  const headers = new Headers();
  for (const name of names) {
    if (name !== "host") {
      headers.set(name, signedHeaders[name]!);
    }
  }
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  );
  return headers;
}
