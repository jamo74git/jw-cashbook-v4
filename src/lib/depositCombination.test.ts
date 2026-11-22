// Banked-cash deposit combination — pure decision logic (design §4.1, test plan A + B).
import { describe, it, expect } from "vitest";
import {
  resolveDepositPrompt,
  canCombineSameWeek,
  type DepositDecisionInput,
  type CombinablePeriod,
} from "@/lib/depositCombination";

function input(over: Partial<DepositDecisionInput> = {}): DepositDecisionInput {
  return {
    currentService: "PM",
    currentHasCash: true,
    sameWeekAmExists: true,
    sameWeekAmHasCash: true,
    sameWeekAmHasSlip: false,
    ...over,
  };
}

describe("resolveDepositPrompt (combine-vs-separate, PM capture only)", () => {
  it("prompts when PM has cash and the same-week AM had cash with no slip yet", () => {
    expect(resolveDepositPrompt(input())).toBe("combine-or-separate");
  });

  it("does not prompt when the AM already has its own slip (PM captures its own)", () => {
    expect(resolveDepositPrompt(input({ sameWeekAmHasSlip: true }))).toBe("none");
  });

  it("does not prompt when there is no same-week AM cash (or no AM period)", () => {
    expect(resolveDepositPrompt(input({ sameWeekAmHasCash: false }))).toBe("none");
    expect(resolveDepositPrompt(input({ sameWeekAmExists: false }))).toBe("none");
  });

  it("does not prompt when the PM itself has no cash", () => {
    expect(resolveDepositPrompt(input({ currentHasCash: false }))).toBe("none");
  });

  it("never prompts in the AM capture (the choice is made in the PM capture)", () => {
    expect(resolveDepositPrompt(input({ currentService: "AM" }))).toBe("none");
  });
});

describe("canCombineSameWeek (same-week safeguard, client mirror of the §2 trigger)", () => {
  const am: CombinablePeriod = { congregationId: "c1", year: 2026, month: 11, week: 1, service: "AM" };
  const pm: CombinablePeriod = { congregationId: "c1", year: 2026, month: 11, week: 1, service: "PM" };

  it("allows an AM + PM pair of the same congregation-week", () => {
    expect(canCombineSameWeek(am, pm)).toBe(true);
  });

  it("rejects a different week / month / year / congregation", () => {
    expect(canCombineSameWeek(am, { ...pm, week: 2 })).toBe(false);
    expect(canCombineSameWeek(am, { ...pm, month: 12 })).toBe(false);
    expect(canCombineSameWeek(am, { ...pm, year: 2027 })).toBe(false);
    expect(canCombineSameWeek(am, { ...pm, congregationId: "c2" })).toBe(false);
  });

  it("rejects a wrong service pairing (e.g. two AM)", () => {
    expect(canCombineSameWeek(am, { ...pm, service: "AM" })).toBe(false);
    expect(canCombineSameWeek({ ...am, service: "PM" }, pm)).toBe(false);
  });
});
