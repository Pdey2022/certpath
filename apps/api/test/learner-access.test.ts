import { describe, expect, it } from "vitest";
import { maskEmail } from "../src/security/learner-access.ts";

// `maskEmail` is the only shape an address may take on the way out of the
// learner-support surface, so its table is written out rather than inferred.
//
// A label of one or two characters is replaced entirely (`***`), never quoted
// back: quoting the first character of a one-character label would publish the
// whole label, which is exactly what "never carries a full label" forbids.

describe("maskEmail", () => {
  it.each([
    // Local part length.
    ["a@example.test", "***@e***.test"],
    ["ab@example.test", "***@e***.test"],
    ["abc@example.test", "a***@e***.test"],
    ["alice@example.test", "a***@e***.test"],
    // Domain label count.
    ["alice@localhost", "a***@l***"],
    ["a@localhost", "***@l***"],
    ["alice@example.test", "a***@e***.test"],
    ["a@mail.example.test", "***@m***.test"],
    ["alice@mail.example.test", "a***@m***.test"],
    // Case is preserved; matching is case-insensitive but the mask is not
    // normalised, so a viewer cannot read the stored case from the mask.
    ["Alice@Example.Test", "A***@E***.Test"],
    ["BOB@LocalHost", "B***@L***"],
    // Whitespace is trimmed before masking.
    ["  alice@example.test  ", "a***@e***.test"],
    // Inputs that are not one address never echo anything back.
    ["not-an-address", "***"],
    ["@example.test", "***"],
    ["alice@", "***"],
  ])("masks %s as %s", (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it("caps the masked value at 254 characters", () => {
    const longTld = "t".repeat(300);
    const masked = maskEmail(`a@b.${longTld}`);
    expect(masked).toHaveLength(254);
    expect(masked).toBe(`***@***.${longTld}`.slice(0, 254));
    // The cap truncates the trailing label, never the local part.
    expect(masked.startsWith("***@***.")).toBe(true);
  });

  it("never returns the full local part of an address it masks", () => {
    for (const local of ["a", "ab", "abc", "alice"]) {
      const masked = maskEmail(`${local}@example.test`);
      const maskedLocal = masked.split("@")[0]!;
      expect(maskedLocal).not.toBe(local);
      expect(maskedLocal.replaceAll("*", "")).not.toBe(local);
    }
  });
});
