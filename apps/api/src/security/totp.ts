import { encodeBase64Url, toArrayBuffer } from "./local-learner-request.ts";
import { constantTimeEqual } from "./http-session.ts";

// The 5F second factor: RFC 6238 TOTP, the sealed seed, recovery codes and
// enrolment tickets.
//
// Parameters are fixed by docs/5f-staff-second-factor.md and are not read from
// configuration: HMAC-SHA1, 6 digits, a 30-second period, one step of skew in
// each direction, and a 160-bit seed. Nothing here logs, returns or caches a
// seed in clear: the only plaintext copy is the single response that shows the
// secret and its `otpauth://` URI once, during enrolment.

export const totpDigits = 6;
export const totpPeriodSeconds = 30;
export const totpPeriodMs = totpPeriodSeconds * 1000;
export const totpSkewSteps = 1;
export const totpSeedBytes = 20;
export const recoveryCodeCount = 10;
export const enrolmentTicketLifetimeMs = 24 * 60 * 60 * 1000;

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32, unpadded. Used only for the `otpauth://` URI and the one-time
 * secret display; the stored form is AES-256-GCM ciphertext.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

/** 160 bits from the platform CSPRNG. */
export function createTotpSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(totpSeedBytes));
}

/** The RFC 6238 time step, `floor(now / 30000)`. */
export function totpStepAt(now: number): number {
  return Math.floor(now / totpPeriodMs);
}

async function importTotpKey(seed: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(seed),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
}

function stepCounter(step: number): Uint8Array {
  const counter = new Uint8Array(8);
  let remaining = step;
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return counter;
}

async function totpCode(key: CryptoKey, step: number): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, toArrayBuffer(stepCounter(step))),
  );
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** totpDigits).padStart(totpDigits, "0");
}

/** One code, for the current step. Used by tests and the CPU benchmark. */
export async function totpCodeAt(
  seed: Uint8Array,
  step: number,
): Promise<string> {
  return totpCode(await importTotpKey(seed), step);
}

/**
 * The highest accepted step whose code matches, or `null`.
 *
 * The returned step is what the caller writes to `last_used_step`, and it must
 * be the *highest* match so a code from the previous step cannot later be
 * replayed after a success in the current one. Comparisons go through
 * `constantTimeEqual` so a wrong code costs the same as a right one.
 */
export async function matchTotpStep(
  seed: Uint8Array,
  code: string,
  now: number,
): Promise<number | null> {
  if (!new RegExp(`^\\d{${totpDigits}}$`).test(code)) return null;
  const current = totpStepAt(now);
  const candidates = [
    current + totpSkewSteps,
    current,
    current - totpSkewSteps,
  ].filter((step) => step >= 0);
  const key = await importTotpKey(seed);
  let matched: number | null = null;
  for (const step of candidates) {
    if (constantTimeEqual(await totpCode(key, step), code) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

/**
 * The AES-256-GCM key for the sealed seed.
 *
 * `STAFF_MFA_SEAL_KEY` is a Worker secret of at least 32 characters; its bytes
 * are hashed to exactly 32 for AES-256. A missing or short value returns `null`
 * and every MFA route that needs it answers 503 - there is no plaintext fallback
 * and no startup-time degradation, because a seed stored in clear would let a
 * `db:export` reader mint codes for ever.
 */
export async function readSealKey(
  value: string | undefined,
): Promise<CryptoKey | null> {
  if (!value) return null;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 32) return null;
  const material = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(material),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface SealedSeed {
  ciphertext: string;
  iv: string;
}

export async function sealTotpSeed(
  key: CryptoKey,
  seed: Uint8Array,
): Promise<SealedSeed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(seed),
    ),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

/** `null` when the ciphertext, IV or key is wrong. Never throws a seed. */
export async function openTotpSeed(
  key: CryptoKey,
  ciphertext: string,
  iv: string,
): Promise<Uint8Array | null> {
  const ciphertextBytes = fromBase64(ciphertext);
  const ivBytes = fromBase64(iv);
  if (!ciphertextBytes || !ivBytes || ivBytes.byteLength !== 12) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
        key,
        toArrayBuffer(ciphertextBytes),
      ),
    );
  } catch {
    return null;
  }
}

/**
 * `otpauth://totp/<issuer>:<account>?...` with the issuer and the algorithm,
 * digits and period written explicitly so an authenticator app cannot guess.
 */
export function otpauthUri(
  issuer: string,
  account: string,
  secret: string,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // Built by hand so the space in a brand name is `%20` everywhere, not `+`.
  const parameters = [
    `secret=${encodeURIComponent(secret)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    "algorithm=SHA1",
    `digits=${totpDigits}`,
    `period=${totpPeriodSeconds}`,
  ].join("&");
  return `otpauth://totp/${label}?${parameters}`;
}

// Crockford-style: no `0`, `O`, `1`, `I` or `L`, so a printed code cannot be
// misread. 30 symbols is not a power of two, so bytes are rejection-sampled
// rather than reduced modulo 30.
const recoveryAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomRecoveryCharacter(): string {
  const limit = 256 - (256 % recoveryAlphabet.length);
  while (true) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    if (byte! < limit) return recoveryAlphabet[byte! % recoveryAlphabet.length]!;
  }
}

/** `XXXXX-XXXXX`, ten characters of about 4.9 bits each. */
export function createRecoveryCode(): string {
  const characters = Array.from({ length: 10 }, randomRecoveryCharacter);
  return `${characters.slice(0, 5).join("")}-${characters.slice(5).join("")}`;
}

/**
 * The canonical form that is hashed. Case, spaces and the separator are the
 * user's typing problem; the digest is over ten upper-case characters.
 */
export function normalizeRecoveryCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      toArrayBuffer(new TextEncoder().encode(value)),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A 256-bit enrolment ticket. `encodeBase64Url` produces the same 43-character
 * shape as a session token; only its SHA-256 digest is stored.
 */
export function createEnrolmentTicket(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
