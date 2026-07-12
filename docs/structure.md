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
