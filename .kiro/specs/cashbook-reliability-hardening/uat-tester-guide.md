# Cashbook — Pre-pilot UAT Tester Guide

> Short user-acceptance pack for the pre-pilot run. Scenario-level only. Lower-level RLS/SQL
> and migration-history checks stay in the technical runbook (`rollout-plan.md` §4–§8); do not
> repeat them here. Record outcomes in `uat-results-sheet.md`.

## Record once for the run (fill in on the day)
| Field | Value |
|---|---|
| Date / tester(s) | __________ |
| Deployed app SHA (build under test) | __________ (expected `8a7ccd5d`) |
| Supabase project reference | __________ (confirm the Production target before testing — pre-window gate 1) |
| Applied migration versions | __________ (expected `20261105120000` two-person sign-off; `20261105130000` Tranche 4 proof access) |
| Automatic dispatch flag | `PROGRESSIVE_DISPATCH_ENABLED` = __________ (expected **false**) |

## Preconditions
- The two migrations above are applied to the confirmed Supabase target per the runbook.
- Synthetic accounts provisioned via the Elder→Overseer→DHO bridge (all clearly test identities):
  Treasurer A, Chairperson A, Auditor A1, Auditor A2, Elder A, Overseer A, DHO; plus a signed-in
  user in a second congregation (Treasurer/Auditor B). Two congregations A and B, each with a
  synthetic proof image.
- Automatic dispatch stays OFF for the whole run. Do not enter real financial data — synthetic only.
- Opening a screen/form is the test; where a step says "do not enter credentials", honour it.

---

## UAT-1 — Treasurer offline capture + proof + reconnect retry (no loss / no duplicate), manual sync
- **Role:** Treasurer A.
- **Test data:** one week's synthetic cashbook figures for congregation A; one synthetic proof image.
- **Steps:**
  1. Sign in as Treasurer A. Put the device offline (disable network).
  2. Capture the week's figures and attach the synthetic proof.
  3. Confirm the work is saved locally with no network and nothing is lost.
  4. Complete Capture and Submit for Audit (Treasurer is the default sign-off).
  5. Bring the device back online. With automatic dispatch OFF, confirm nothing transfers on its own.
  6. Trigger a manual sync. Confirm the capture and the proof transfer to the server.
  7. Trigger manual sync again (simulating a lost-acknowledgement retry).
- **Expected result:** work persists offline and survives reconnect; with dispatch off nothing sends
  until the manual sync; the manual sync transfers the capture + proof exactly once; the repeat sync
  creates no duplicate period, line, or proof; no evidence is dropped; the proof is uploaded intact.

## UAT-2 — Two eligible auditors: first sign-off pending, second approves the same revision
- **Role:** Auditor A1, then Auditor A2.
- **Test data:** the Submitted, Review-Ready revision produced in UAT-1.
- **Steps:**
  1. Auditor A1 opens the submitted revision and records the first sign-off.
  2. Observe the capture's state.
  3. Auditor A2 (a different person) records the second sign-off on the same revision.
  4. Observe the capture's state and history.
- **Expected result:** after one sign-off the capture stays **pending** (not approved); the second
  eligible auditor's sign-off on the same revision moves it to **AuditApproved**; both sign-offs are
  recorded in history; no one person signs twice.

## UAT-3 — Chairperson fallback second sign-off (recorded reason, not involved)
- **Role:** Auditor A1, then Chairperson A.
- **Test data:** a Submitted, Review-Ready revision for congregation A where only one auditor is
  available; the Chairperson did not prepare, edit, submit, or act as Treasurer for this capture.
- **Steps:**
  1. Auditor A1 records the first sign-off → capture pending.
  2. Chairperson A records the second sign-off, entering the required reason (e.g. second auditor
     unavailable).
  3. Observe the approval and the label shown.
- **Expected result:** the Chairperson fallback is allowed only with a recorded reason and only
  because they were not involved; it approves the same revision; the approval is labelled as a
  Chairperson acting-as-auditor second sign-off. (A Chairperson who had acted as Treasurer on this
  capture would be refused — covered by the technical runbook.)

## UAT-4 — Unresolved case referred to the Elder (stays pending, no Elder signature)
- **Role:** Auditor A1, then Elder A.
- **Test data:** a Submitted, Review-Ready revision for congregation A with no eligible second
  signer available (one auditor only; Chairperson ineligible/involved).
- **Steps:**
  1. Auditor A1 records the first sign-off → capture pending.
  2. With no eligible second signer, the capture is referred to the Elder assigned to congregation A.
  3. Elder A opens the referral and reviews why it is pending.
- **Expected result:** the capture remains **pending**; the Elder sees the reason and can coordinate
  the missing reviewer; the Elder does **not** sign (Elder oversight is not an audit signature);
  there is no one-signature closure. Overseer escalation only if the Elder cannot resolve it.

## UAT-5 — Proof access: authorised auditor can open; other congregation cannot
- **Role:** Auditor A1 (positive); a signed-in user in congregation B (negative).
- **Test data:** the synthetic proof in congregation A.
- **Steps:**
  1. Auditor A1 opens the congregation A proof.
  2. The congregation B user attempts to open that same congregation A proof.
- **Expected result:** the authorised congregation A auditor can open and view the proof; the
  congregation B user is denied access to the same proof. Both act as ordinary signed-in users.
