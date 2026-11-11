import { scryptAsync } from "@noble/hashes/scrypt.js";

export const learnerPasswordHashParameters = {
  algorithm: "scrypt",
  cost: 32_768,
  blockSize: 8,
  parallelism: 1,
  keyBytes: 32,
  saltBytes: 16,
  maxMemoryBytes: 64 * 1024 * 1024,
} as const;

const encodedHashPattern =
  /^\$scrypt\$ln=15,r=8,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const bytes = Uint8Array.from(
      atob(value + "=".repeat((4 - (value.length % 4)) % 4)),
      (character) => character.charCodeAt(0),
    );
    return encodeBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export class PasswordHashUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Password hashing is unavailable in this runtime");
    this.name = "PasswordHashUnavailableError";
    this.cause = cause;
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return scryptAsync(password, salt, {
    N: learnerPasswordHashParameters.cost,
    r: learnerPasswordHashParameters.blockSize,
    p: learnerPasswordHashParameters.parallelism,
    dkLen: learnerPasswordHashParameters.keyBytes,
    asyncTick: 10,
    maxmem: learnerPasswordHashParameters.maxMemoryBytes,
  });
}

export async function hashLearnerPassword(password: string): Promise<string> {
  try {
    const salt = crypto.getRandomValues(
      new Uint8Array(learnerPasswordHashParameters.saltBytes),
    );
    const derivedKey = await deriveKey(password, salt);
    return `$scrypt$ln=15,r=8,p=1$${encodeBase64(salt)}$${encodeBase64(derivedKey)}`;
  } catch (error) {
    throw new PasswordHashUnavailableError(error);
  }
}

export async function verifyLearnerPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const match = encodedHashPattern.exec(encodedHash);
  if (!match) {
    throw new PasswordHashUnavailableError(
      new Error("Unsupported password hash format"),
    );
  }
  const salt = decodeBase64(match[1]);
  const expectedKey = decodeBase64(match[2]);
  if (
    !salt ||
    salt.byteLength !== learnerPasswordHashParameters.saltBytes ||
    !expectedKey ||
    expectedKey.byteLength !== learnerPasswordHashParameters.keyBytes
  ) {
    throw new PasswordHashUnavailableError(new Error("Malformed password hash"));
  }
  try {
    const derivedKey = await deriveKey(password, salt);
    return constantTimeEqual(derivedKey, expectedKey);
  } catch (error) {
    throw new PasswordHashUnavailableError(error);
  }
}
