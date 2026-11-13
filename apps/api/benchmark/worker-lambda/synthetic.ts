const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_{}~";

function build(multiplier: number, offset: number): string {
  return Array.from(
    { length: 64 },
    (_, index) => alphabet[(index * multiplier + offset) % alphabet.length],
  ).join("");
}

// Fixed synthetic inputs shared by the Worker and the local test client so a
// locally generated hash can be verified by Lambda. They are not real secrets.
export function syntheticPassword(): string {
  return build(37, 19);
}

export function syntheticWrongPassword(): string {
  return build(41, 7);
}
