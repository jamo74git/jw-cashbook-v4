import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { getOacWeeks } from "@/lib/oacWeeks";

function sundaysOfMonth(year: number, month: number): Date[] {
  const arr: Date[] = [];
  const dim = new Date(year, month, 0).getDate();
  for (let d = 1; d <= dim; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() === 0) arr.push(dt);
  }
  return arr;
}

function firstSundayOfNextMonth(year: number, month: number): Date {
  const nm = month === 12 ? 1 : month + 1;
  const ny = month === 12 ? year + 1 : year;
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(ny, nm - 1, d);
    if (dt.getDay() === 0) return dt;
  }
  throw new Error("unreachable");
}

describe("getOacWeeks", () => {
  // Feature: restore-to-vite, Property 1: Week 1 opens on the 2nd Sunday of the month
  // and the final week opens on the 1st Sunday of the next month.
  it("Property 1: week 1 = 2nd Sunday; final week = 1st Sunday of next month", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2035 }),
        fc.integer({ min: 1, max: 12 }),
        (year, month) => {
          const weeks = getOacWeeks(year, month);
          const monthSundays = sundaysOfMonth(year, month);
          expect(weeks.length).toBeGreaterThan(0);
          // Week 1 opens on the 2nd Sunday of the month.
          expect(weeks[0].date.getTime()).toBe(monthSundays[1].getTime());
          // Final week opens on the 1st Sunday of the next month.
          expect(weeks[weeks.length - 1].date.getTime()).toBe(
            firstSundayOfNextMonth(year, month).getTime()
          );
          // weekKey format YYYY-MM-Wn.
          expect(weeks[0].weekKey).toMatch(/^\d{4}-\d{2}-W\d+$/);
        }
      ),
      { numRuns: 200 }
    );
  });
});
