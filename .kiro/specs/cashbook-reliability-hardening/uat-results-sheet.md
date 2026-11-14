# Cashbook — Pre-pilot UAT Results Sheet

> Record outcomes here. Full steps are in `uat-tester-guide.md` (same Test IDs). Results are left
> blank for the run. Status = Pass / Fail / Blocked / Not run.

## Run header (record once)
| Field | Value |
|---|---|
| Date | __________ |
| Tester(s) | __________ |
| Deployed app SHA | __________ |
| Supabase project reference | __________ |
| Applied migration versions | __________ |
| `PROGRESSIVE_DISPATCH_ENABLED` | __________ |

## Results
| Test | Role(s) | Test data | Expected result (summary) | Actual result | Status |
|---|---|---|---|---|---|
| UAT-1 Offline capture + proof + reconnect retry, manual sync | Treasurer A | 1 week synthetic figures + 1 synthetic proof, cong. A | Saved offline, survives reconnect; dispatch off = nothing auto-sends; manual sync transfers once; repeat sync = no duplicate; no loss | | |
| UAT-2 Two-auditor sign-off | Auditor A1, Auditor A2 | Submitted Review-Ready revision from UAT-1 | First sign-off leaves pending; second eligible sign-off approves same revision; both in history; no same-person-twice | | |
| UAT-3 Chairperson fallback sign-off | Auditor A1, Chairperson A | Review-Ready revision, one auditor only, Chairperson not involved | Second sign-off allowed with recorded reason + non-involvement; approves same revision; labelled Chairperson acting-as-auditor | | |
| UAT-4 Elder referral (unresolved) | Auditor A1, Elder A | Review-Ready revision, no eligible second signer | Stays pending; Elder sees reason + coordinates; no Elder signature; no one-signature closure | | |
| UAT-5 Proof access positive/negative | Auditor A1 (pos), cong. B user (neg) | Synthetic proof in cong. A | Authorised cong. A auditor opens the proof; cong. B user denied the same proof | | |

## Notes / blockers observed
_(leave blank for the run)_
