# Product: JW Cashbook v4

## Core Capture Flow - Treasurer
1.  Select: Congregation, Month, Week, Service AM/PM
2.  Members Tithing Tab: Select Officer Code -> Add lines: Type[EFT/Cash/DD], Count, Amount
3.  Officers Tithing Tab: Select Officer Code -> Add lines
4.  Burial Tab: Receipt#, Amount, Upload Proof
5.  Banking Tab: PaymentDate, Type, Amount. If Cash: proof_status=Pending. Upload proof to mark Deposited
6.  Expenses Tab: Date, Description, Amount - expenses above R500 require approval.
7.  Submit -> Status = Submitted. Soft lock.

## Cashbook Balancing Formula
This is the core audit rule from HQ.

Total Income = Members Tithing + Officers Tithing + Burial Income
Total Deductions = Expenses
Banked Amount = Total Income - Total Deductions

System Validation: Total Income MUST EQUAL Banked Amount + Total Deductions

Note: Expenses are deductions, not income. Tithing total + burial total = banking total + expenses

## Proof and Count Rules
To match the physical cashbook and avoid fraud:

1. Income Types: Only 3 types allowed: EFT, DirectDebit, Cash
2. Count: The "Count" column is only for EFT and DirectDebit. It represents number of slips/proofs. Cash has no count.
3. Proof Required: Attachment/proof_status is MANDATORY for: EFT, DirectDebit, Burial, Expenses
4. Proof NOT Required: Cash transactions. proof_status must be NULL

## Audit Flow - Mobile
Auditor opens "Pending Audits" list. Taps week. Sees all totals + proof icons. 
Buttons: Approve All or Reject with Comment. 

## Elder Month-End Flow - Mobile
Elder selects Congregation from dropdown. If all 4/5 weeks = AuditApproved, show "Submit to HO" button.

## Reporting
HO/Overseer/Apostle Desktop: Consolidated table by hierarchy. Drill down to congregation -> week -> officer.
Secretary: Month summary PDF. No proof links.

## Priest Census Responsibility
Each Priest is responsible for capturing his own monthly census. The Treasurer cannot edit Priest census.
The system automatically rolls up all Priest census records to display the Congregation Total on the Cashbook dashboard.
This total is used for the % Faithfulness KPI.

## Census Lock + Audit Rules
1. Lock: Once the Cashbook for a month is submitted and AuditApproved, all Priest Census for that month is locked. No edits allowed.
2. Audit: Every change to a census field is logged with who, when, old and new value.
3. Staleness: If a Priest has not updated his census in 3 months = Orange warning. 6 months = Red warning on the Priest dashboard.

## Audit Submission Rule
A Cashbook Period cannot be submitted for Audit until it is 100% balanced.
Formula: Total Income = Banked Amount + Total Expenses
The Auditor's role is to verify proofs, dates, and classification. The system enforces the balancing before submission.

## HO Governance Control: Expenses
Per OAC Governance, no congregation may spend more than R500 per month on expenses without Elder oversight.
System Enforcement: If total monthly expenses > R500 at time of submission, the system requires:
1.  Requestor Comment: Reason for over-expenditure
2.  Elder Approval Comment: Elder must approve with comment
Both comments are stored and visible to HO during audit. No HO workflow is built - oversight is via Elder.