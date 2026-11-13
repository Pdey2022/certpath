const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_{}~";

function build(length: number, multiplier: number, offset: number): string {
  return Array.from(
    { length },
    (_, index) => alphabet[(index * multiplier + offset) % alphabet.length],
  ).join("");
}

// Fixed, synthetic accounts for the sign-in CPU benchmark. They are not real
// credentials and exist only in this isolated test.
export const syntheticAccounts = [
  { email: "signin-cpu-a@example.test", password: build(24, 29, 3) },
  { email: "signin-cpu-b@example.test", password: build(24, 31, 11) },
] as const;

export const syntheticUnknownEmail = "signin-cpu-unknown@example.test";

export function syntheticWrongSignInPassword(): string {
  return build(24, 43, 5);
}
