# Kiro Steering: JW Cashbook v4 - Officers + Sequential + Mobile Audit

## Product Vision
Enterprise cashbook. Capture by Officer Code. Audit and Submit done on Mobile. 
Responsive for HO/Apostle/Overseer desktop review.

## Hierarchy Model - Corrected
Conference > Apostolate > District > Apostleship > Overseership > Eldership > Congregation
Note: Apostle oversees Overseerships. 3+ Apostleships = District

## Roles & Permissions
- HO: CRUD users, congregations, officers. Read all.
- Apostle: Read all in Apostleship + below.
- Overseer: Read all in Overseership + below.
- Elder: Read all in Eldership + below. Mobile "Submit to HO" per congregation.
- Chairperson/Priest: Capture like Treasurer.
- Treasurer: Capture by Officer Code.
- Auditor x2: Mobile approval at congregation. All-or-nothing.
- Secretary: Read-only summary, no attachments. For monthly meeting.

## Critical Workflow Rules
1.  Capture Key: congregation_id + year + month + week + service[AM/PM]
2.  Sequential Lock: Week N locked until Week N-1 = Audit Approved
3.  Week Logic: Week1 starts on 2nd Sunday. Week1 can be in prev month.
4.  Officers Capture: Members and Officers sections require officer_id dropdown
5.  Status: Draft -> Submitted -> AuditApproved -> SubmittedToHO -> HOReviewed. AuditRejected returns to draft
6.  Banking: proof_status = Pending | Deposited
7.  Mobile First: All roles can use mobile. Desktop enhances review.

## Data Rules
No user can edit after AuditApproved. Secretary role cannot select * from attachments.
