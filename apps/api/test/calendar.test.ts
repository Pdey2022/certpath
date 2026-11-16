import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  addTerm,
  termLengthDays,
  type TermSpec,
} from "../src/calendar.ts";

const day = 86_400_000;
const at = (iso: string): number => Date.parse(iso);
const iso = (instant: number): string => new Date(instant).toISOString();

describe("addCalendarMonths", () => {
  it("clamps a month end to the last valid day and keeps the time of day", () => {
    expect(iso(addCalendarMonths(at("2026-01-31T14:30:00.000Z"), 1))).toBe(
      "2026-02-28T14:30:00.000Z",
    );
  });

  it("clamps to 29 February in a leap year", () => {
    expect(iso(addCalendarMonths(at("2024-01-31T00:00:00.000Z"), 1))).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("clamps the 31st to a 30-day month", () => {
    expect(iso(addCalendarMonths(at("2026-03-31T09:00:00.000Z"), 1))).toBe(
      "2026-04-30T09:00:00.000Z",
    );
  });

  it("clamps a leap day twelve months forward", () => {
    expect(iso(addCalendarMonths(at("2024-02-29T12:00:00.000Z"), 12))).toBe(
      "2025-02-28T12:00:00.000Z",
    );
  });

  it("does not clamp when the target month is long enough", () => {
    expect(iso(addCalendarMonths(at("2026-05-31T00:00:00.000Z"), 3))).toBe(
      "2026-08-31T00:00:00.000Z",
    );
  });

  it("produces the 89-day three-month term bought on 1 February", () => {
    const start = at("2026-02-01T00:00:00.000Z");
    const end = addCalendarMonths(start, 3);
    expect(iso(end)).toBe("2026-05-01T00:00:00.000Z");
    expect((end - start) / day).toBe(89);
  });

  it("produces a 92-day three-month term bought on 1 July", () => {
    const start = at("2026-07-01T00:00:00.000Z");
    const end = addCalendarMonths(start, 3);
    expect(iso(end)).toBe("2026-10-01T00:00:00.000Z");
    expect((end - start) / day).toBe(92);
  });

  it("rolls the year over and still clamps", () => {
    expect(iso(addCalendarMonths(at("2026-12-31T00:00:00.000Z"), 2))).toBe(
      "2027-02-28T00:00:00.000Z",
    );
  });

  it("preserves milliseconds", () => {
    expect(iso(addCalendarMonths(at("2026-01-31T23:59:59.999Z"), 1))).toBe(
      "2026-02-28T23:59:59.999Z",
    );
  });

  it("rejects zero, negative, fractional and non-finite month counts", () => {
    const instant = at("2026-01-31T00:00:00.000Z");
    for (const months of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addCalendarMonths(instant, months)).toThrow(RangeError);
    }
  });

  it("rejects a non-finite or fractional instant", () => {
    for (const instant of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
    ]) {
      expect(() => addCalendarMonths(instant, 1)).toThrow(RangeError);
    }
  });

  it("does not compose: +1 month twice is not +2 months", () => {
    const january = at("2026-01-31T00:00:00.000Z");
    const twice = addCalendarMonths(addCalendarMonths(january, 1), 1);
    const once = addCalendarMonths(january, 2);
    expect(iso(twice)).toBe("2026-03-28T00:00:00.000Z");
    expect(iso(once)).toBe("2026-03-31T00:00:00.000Z");
    expect(twice).not.toBe(once);
  });

  it("is monotone non-decreasing across instants that share a time of day", () => {
    // Clamping keeps calendar arithmetic ordered by date; it is the time-of-day
    // component that can invert two instants which clamp into the same target
    // day (see the next test), so the sampled property is stated at a fixed time
    // of day - which is also how every window in this system is anchored.
    const from = at("2023-11-01T12:00:00.000Z");
    const to = at("2027-03-01T12:00:00.000Z");
    const step = day;
    for (const months of [1, 2, 3, 6, 12]) {
      let previous = Number.NEGATIVE_INFINITY;
      for (let instant = from; instant <= to; instant += step) {
        const result = addCalendarMonths(instant, months);
        expect(result).toBeGreaterThanOrEqual(previous);
        previous = result;
      }
    }
  });

  it("does not order two instants that clamp into the same day at different times", () => {
    // Documented behaviour, not a defect to fix here: a day clamp maps 30 and 31
    // January onto 30 April, and the time of day then decides the order, so a
    // later instant can produce an earlier expiry. Any invariant that compares
    // two calendar-added instants must therefore be built so that it does not
    // depend on ordering across a clamp - the bundle's capped Standard leg
    // (`max(coverageEnd, addTerm(now, term))`) does exactly that.
    const earlier = at("2026-01-30T18:00:00.000Z");
    const later = at("2026-01-31T00:00:00.000Z");
    expect(earlier).toBeLessThan(later);
    expect(iso(addCalendarMonths(earlier, 3))).toBe("2026-04-30T18:00:00.000Z");
    expect(iso(addCalendarMonths(later, 3))).toBe("2026-04-30T00:00:00.000Z");
    expect(addCalendarMonths(later, 3)).toBeLessThan(
      addCalendarMonths(earlier, 3),
    );
  });
});

describe("addTerm", () => {
  it("applies calendar months through addCalendarMonths", () => {
    const start = at("2026-01-31T14:30:00.000Z");
    expect(
      addTerm(start, { unit: "calendar_months", months: 1 }),
    ).toBe(addCalendarMonths(start, 1));
  });

  it("applies a day term exactly", () => {
    const start = at("2026-01-31T14:30:00.000Z");
    expect(addTerm(start, { unit: "days", days: 30 })).toBe(
      start + 30 * day,
    );
  });

  it("rejects a non-positive or fractional day term", () => {
    const start = at("2026-01-31T00:00:00.000Z");
    for (const days of [0, -30, 1.5]) {
      expect(() => addTerm(start, { unit: "days", days })).toThrow(RangeError);
    }
  });
});

describe("termLengthDays", () => {
  it("counts whole days for both units", () => {
    const february: TermSpec = { unit: "calendar_months", months: 3 };
    const thirtyDays: TermSpec = { unit: "days", days: 30 };
    expect(termLengthDays(at("2026-02-01T00:00:00.000Z"), february)).toBe(89);
    expect(termLengthDays(at("2026-07-01T00:00:00.000Z"), february)).toBe(92);
    expect(termLengthDays(at("2026-02-01T00:00:00.000Z"), thirtyDays)).toBe(30);
  });

  it("stays whole for a leap day and an instant late in the day", () => {
    const twelveMonths: TermSpec = { unit: "calendar_months", months: 12 };
    expect(
      termLengthDays(at("2024-02-29T12:00:00.000Z"), twelveMonths),
    ).toBe(365);
    expect(
      termLengthDays(at("2026-01-31T23:59:59.999Z"), twelveMonths),
    ).toBe(365);
  });
});
