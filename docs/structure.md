# Folder Structure: JW Cashbook v4

/src
├── /features
│   ├── /auth            # OTP Login
│   ├── /capture         
│   │   ├── PeriodSelector.tsx  # Cong + Month + Week + Service
│   │   ├── OfficerCaptureForm.tsx # Dropdown for Officer Code
│   │   └── BankingProofUpload.tsx
│   ├── /audit            # MobileAuditScreen.tsx
│   ├── /submit           # ElderSubmitToHO.tsx - Mobile
│   ├── /review           # DesktopConsolidatedView.tsx
│   └── /admin            # OfficerManagement.tsx
├── /lib
│   ├── workflow.ts       # get_week_number, can_capture_period
│   └── hierarchy.ts      # recursive queries
└── /types
    └── database.types.ts

## Table: priest_census
Purpose: Tracks demographic count per Priest per month. Used to calculate % Faithfulness.
Columns:
- id: uuid, PK
- congregation_id: uuid, FK to hierarchy. RLS scoped to congregation
- priest_id: uuid, FK to officers. Must be role = 'Priest'
- year: int
- month: int
- underdeacon_count: int, UDs working under this Priest
- children_under_15: int
- youth_under_26: int  
- youth_under_35: int
- adults_under_60: int
- seniors_60_plus: int
- working_members: int, denominator for % faithfulness = Members.item_count / working_members
- captured_by: uuid, FK to auth.users
- captured_at: timestamptz
- UNIQUE(priest_id, year, month)

## Table: cashbook_line_item - COMMENTS & RULES
Purpose: Single table for all 4 sections. Distinguishes income vs deduction by section.

Key Columns:
- section: enum['Members','Officers','Burial','Expenses']. Determines if it's income or deduction
- item_type: text, NOT NULL. For Members/Officers = 'EFT'/'Cash'/'DirectDebit'. For Burial = 'Burial Offering'. For Expenses = Description e.g 'Coffee & Tea'
- payment_type: text, CHECK IN ('EFT','DirectDebit','Cash'). 1 of 3 income types only
- manual_reference: text, For Burial receipt number e.g '287281'
- officer_id: uuid, FK to officers. Required for Members and Officers sections only. For accountability
- item_count: int, NULLABLE. Count of slips/proofs. Only for EFT and DirectDebit. Must be NULL for Cash
- amount: numeric, NOT NULL
- proof_status: text. Required for EFT, DirectDebit, Burial, Expenses. Must be NULL for Cash

## Business Rules Enforced by App Logic
1. Banking Total = (Members + Officers + Burial) - Expenses. Auto-calculated, not stored
2. Validation: Tithing + Burial = Banking + Expenses
3. Count Logic: Only sum item_count where payment_type IN ('EFT','DirectDebit')
4. Proof Logic: proof_status IS NULL when payment_type = 'Cash'

## Table: priest_census - ADDITIONS
- updated_at: timestamptz. Auto-updates on edit. Used for staleness warning
- locked: boolean default false. Set to true when cashbook for that year/month is AuditApproved

## Table: priest_census_log
Purpose: Full audit trail to prevent manipulation of census figures
Columns:
- id: uuid, PK
- priest_census_id: uuid, FK to priest_census
- changed_by: uuid, FK to auth.users
- changed_at: timestamptz default now()
- field_name: text, e.g 'working_members'
- old_value: text
- new_value: text