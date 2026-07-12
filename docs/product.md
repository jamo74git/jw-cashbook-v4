# Product: JW Cashbook v4

## Core Capture Flow - Treasurer
1.  Select: Congregation, Month, Week, Service AM/PM
2.  Members Tithing Tab: Select Officer Code -> Add lines: Type[EFT/Cash/DD], Count, Amount
3.  Officers Tithing Tab: Select Officer Code -> Add lines
4.  Burial Tab: Receipt#, Amount, Upload Proof
5.  Banking Tab: PaymentDate, Type, Amount. If Cash: proof_status=Pending. Upload proof to mark Deposited
6.  Expenses Tab: Date, Description, Amount - expenses above R500 require approval.
7.  Submit -> Status = Submitted. Soft lock.

## Audit Flow - Mobile
Auditor opens "Pending Audits" list. Taps week. Sees all totals + proof icons. 
Buttons: Approve All or Reject with Comment. 

## Elder Month-End Flow - Mobile
Elder selects Congregation from dropdown. If all 4/5 weeks = AuditApproved, show "Submit to HO" button.

## Reporting
HO/Overseer/Apostle Desktop: Consolidated table by hierarchy. Drill down to congregation -> week -> officer.
Secretary: Month summary PDF. No proof links.
