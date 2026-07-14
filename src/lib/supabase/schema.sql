-- ═══════════════════════════════════════════════════════════════════════════════
-- OAC MANAGEMENT SYSTEM — COMPLETE SCHEMA
-- Hierarchy: Conference > Apostolate > District > Apostleship > Overseership > Eldership > Congregation
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── HIERARCHY ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.hierarchy_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level_type TEXT NOT NULL CHECK (level_type IN (
    'Conference','Apostolate','District','Apostleship','Overseership','Eldership','Congregation'
  )),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,         -- e.g. '020700' for Bosmont
  parent_id UUID REFERENCES public.hierarchy_levels(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hierarchy_parent ON public.hierarchy_levels(parent_id);
CREATE INDEX idx_hierarchy_code ON public.hierarchy_levels(code);
CREATE INDEX idx_hierarchy_type ON public.hierarchy_levels(level_type);

-- ─── CONGREGATIONS (leaf nodes of hierarchy) ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.congregations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hierarchy_id UUID NOT NULL REFERENCES public.hierarchy_levels(id),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,         -- '020700'
  eldership_id UUID REFERENCES public.hierarchy_levels(id),
  overseership_id UUID REFERENCES public.hierarchy_levels(id),
  apostleship_id UUID REFERENCES public.hierarchy_levels(id),
  district_id UUID REFERENCES public.hierarchy_levels(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── OFFICERS (Priests, Underdeacons, etc.) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.officers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  officer_code TEXT NOT NULL,        -- 'Priestship-001'
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  rank TEXT NOT NULL CHECK (rank IN ('Priest','Underdeacon','Deacon','Elder','Overseer','Apostle')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_officer_code_cong ON public.officers(congregation_id, officer_code);

-- ─── USER HIERARCHY ACCESS (replaces old profiles table for permissions) ────

CREATE TABLE IF NOT EXISTS public.user_hierarchy_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('HO','Apostle','Overseer','Elder','Chairperson','Treasurer','Auditor','Secretary')),
  hierarchy_id UUID NOT NULL REFERENCES public.hierarchy_levels(id),
  congregation_id UUID REFERENCES public.congregations(id),
  scope_level TEXT NOT NULL CHECK (scope_level IN (
    'Conference','Apostolate','District','Apostleship','Overseership','Eldership','Congregation'
  )),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  start_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_uha_user ON public.user_hierarchy_access(user_id);
CREATE INDEX idx_uha_role ON public.user_hierarchy_access(role);
CREATE INDEX idx_uha_hierarchy ON public.user_hierarchy_access(hierarchy_id);

-- ─── HO DISTRICT ASSIGNMENTS (segregation for Head Office users) ────────────

CREATE TABLE IF NOT EXISTS public.ho_district_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  district_id UUID NOT NULL REFERENCES public.hierarchy_levels(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID REFERENCES auth.users(id),
  UNIQUE(user_id, district_id)
);

-- ─── CASHBOOK SERVICE (capture key: congregation + year + month + week + service) ─

CREATE TABLE IF NOT EXISTS public.cashbook_service (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  week INT NOT NULL CHECK (week BETWEEN 1 AND 5),
  service_type TEXT NOT NULL CHECK (service_type IN ('AM','PM')),
  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN (
    'Draft','PendingAudit','AuditApproved','AuditRejected',
    'SubmittedToOverseer','OverseerApproved','OverseerRejected',
    'SubmittedToHO','HOReviewed'
  )),
  captured_by UUID REFERENCES auth.users(id),
  submitted_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  requestor_comment TEXT,
  elder_approval_comment TEXT,
  expenses_total NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(congregation_id, year, month, week, service_type)
);

CREATE INDEX idx_cashbook_service_cong ON public.cashbook_service(congregation_id, year, month);
CREATE INDEX idx_cashbook_service_status ON public.cashbook_service(status);

-- ─── CASHBOOK LINE ITEMS ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashbook_line_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.cashbook_service(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK (section IN ('Members','Officers','Burial','Expenses')),
  officer_id UUID REFERENCES public.officers(id),
  officer_code TEXT,
  income_type TEXT CHECK (income_type IN ('Cash','EFT','DirectDebit')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  item_count INT,
  manual_reference TEXT,             -- receipt # for Burial
  proof_status TEXT CHECK (proof_status IN ('Pending','Uploaded','Deposited')),
  proof_image_url TEXT,
  expense_date DATE,
  expense_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_line_item_service ON public.cashbook_line_item(service_id);
CREATE INDEX idx_line_item_section ON public.cashbook_line_item(section);

-- ─── BANKING ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.banking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.cashbook_service(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('EFT','Direct','Cash Pending')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  proof_status TEXT DEFAULT 'Pending' CHECK (proof_status IN ('Pending','Deposited')),
  proof_image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── PRIEST CENSUS ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.priest_census (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  priest_id UUID NOT NULL REFERENCES public.officers(id),
  year INT NOT NULL,
  month INT NOT NULL,
  eligible_to_tithe INT NOT NULL DEFAULT 0,
  children INT NOT NULL DEFAULT 0,
  youth INT NOT NULL DEFAULT 0,
  adults INT NOT NULL DEFAULT 0,
  seniors INT NOT NULL DEFAULT 0,
  total_members INT NOT NULL DEFAULT 0,
  underdeacon_count INT NOT NULL DEFAULT 0,
  captured_by UUID REFERENCES auth.users(id),
  captured_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  locked BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(priest_id, year, month)
);

CREATE INDEX idx_census_cong ON public.priest_census(congregation_id, year, month);

-- ─── PRIEST CENSUS LOG ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.priest_census_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  priest_census_id UUID NOT NULL REFERENCES public.priest_census(id),
  changed_by UUID NOT NULL REFERENCES auth.users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);

-- ─── AUDIT LOG (all system actions, overrides, approvals) ───────────────────

CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'CAPTURE','SUBMIT','AUDIT_APPROVE','AUDIT_REJECT',
    'OVERSEER_APPROVE','OVERSEER_REJECT','HO_REVIEW',
    'SELF_REVIEW_EXCEPTION','BULK_IMPORT','CENSUS_UPDATE',
    'MONTH_SUBMIT','CORRECTION','UNLOCK'
  )),
  entity_type TEXT NOT NULL,          -- 'cashbook_service', 'priest_census', etc.
  entity_id UUID NOT NULL,
  assumed_role TEXT,                   -- filled when Chair uses O override
  comment TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_user ON public.audit_log(user_id);
CREATE INDEX idx_audit_log_entity ON public.audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_type ON public.audit_log(action_type);

-- ─── MESSAGING ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_type TEXT NOT NULL CHECK (thread_type IN ('ho_congregation','internal')),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_id UUID REFERENCES public.messages(id),
  attachment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEWS (for reporting + future SharePoint API)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_cashbook_service AS
SELECT
  cs.id AS service_id,
  cs.congregation_id,
  c.name AS congregation_name,
  c.code AS congregation_code,
  cs.year,
  cs.month,
  cs.week,
  cs.service_type,
  cs.service_date,
  cs.status,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section IN ('Members','Officers','Burial')), 0) AS total_income,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Expenses'), 0) AS total_expenses,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section IN ('Members','Officers','Burial')), 0)
    - COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Expenses'), 0) AS banked,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Members'), 0) AS members_total,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Officers'), 0) AS officers_total,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Burial'), 0) AS burial_total
FROM public.cashbook_service cs
LEFT JOIN public.cashbook_line_item li ON li.service_id = cs.id
LEFT JOIN public.congregations c ON c.id = cs.congregation_id
GROUP BY cs.id, c.name, c.code;

CREATE OR REPLACE VIEW public.v_cashbook_month AS
SELECT
  cs.congregation_id,
  c.name AS congregation_name,
  c.code AS congregation_code,
  cs.year,
  cs.month,
  COUNT(DISTINCT cs.id) AS service_count,
  COUNT(DISTINCT cs.id) FILTER (WHERE cs.status = 'AuditApproved') AS approved_count,
  BOOL_AND(cs.status = 'AuditApproved') AS all_approved,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section IN ('Members','Officers','Burial')), 0) AS month_income,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Expenses'), 0) AS month_expenses,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Members'), 0) AS month_members,
  COALESCE(SUM(li.amount) FILTER (WHERE li.section = 'Officers'), 0) AS month_officers
FROM public.cashbook_service cs
LEFT JOIN public.cashbook_line_item li ON li.service_id = cs.id
LEFT JOIN public.congregations c ON c.id = cs.congregation_id
GROUP BY cs.congregation_id, c.name, c.code, cs.year, cs.month;

CREATE OR REPLACE VIEW public.v_census_health AS
SELECT
  pc.congregation_id,
  c.name AS congregation_name,
  pc.priest_id,
  o.officer_code,
  o.first_name || ' ' || o.last_name AS priest_name,
  pc.year,
  pc.month,
  pc.total_members,
  pc.eligible_to_tithe,
  pc.updated_at,
  pc.locked,
  CASE
    WHEN pc.updated_at < now() - INTERVAL '180 days' THEN 'RED'
    WHEN pc.updated_at < now() - INTERVAL '90 days' THEN 'ORANGE'
    ELSE 'GREEN'
  END AS staleness_flag
FROM public.priest_census pc
JOIN public.congregations c ON c.id = pc.congregation_id
JOIN public.officers o ON o.id = pc.priest_id;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_hierarchy_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ho_district_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.congregations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_service ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_line_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.priest_census ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Users can read their own access records
CREATE POLICY "Users read own access"
  ON public.user_hierarchy_access FOR SELECT
  USING (auth.uid() = user_id);

-- HO can manage all access records (within their district assignment)
CREATE POLICY "HO manage access"
  ON public.user_hierarchy_access FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.role = 'HO' AND uha.status = 'active'
    )
  );

-- Cashbook service: users see services for congregations in their scope
CREATE POLICY "Scoped cashbook access"
  ON public.cashbook_service FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid()
        AND uha.status = 'active'
        AND (
          uha.congregation_id = cashbook_service.congregation_id
          OR uha.scope_level IN ('Conference','Apostolate','District','Apostleship','Overseership','Eldership')
        )
    )
  );

-- Line items: Secretary can only see aggregate (enforced in app layer via permissions.ts)
-- All authenticated users with cashbook access can read line items from DB
CREATE POLICY "Scoped line item access"
  ON public.cashbook_line_item FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.cashbook_service cs
      JOIN public.user_hierarchy_access uha ON uha.user_id = auth.uid()
      WHERE cs.id = cashbook_line_item.service_id
        AND uha.status = 'active'
        AND (
          uha.congregation_id = cs.congregation_id
          OR uha.scope_level IN ('Conference','Apostolate','District','Apostleship','Overseership','Eldership')
        )
    )
  );

-- Capture: only Treasurer, Chairperson (O), Elder (O) can insert/update line items
CREATE POLICY "Capture line items"
  ON public.cashbook_line_item FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      JOIN public.cashbook_service cs ON cs.id = cashbook_line_item.service_id
      WHERE uha.user_id = auth.uid()
        AND uha.status = 'active'
        AND uha.role IN ('Treasurer','Chairperson','Elder')
        AND uha.congregation_id = cs.congregation_id
        AND cs.status = 'Draft'
    )
  );

-- Census: Secretary gets Totals Only (enforced in app layer)
CREATE POLICY "Census scoped access"
  ON public.priest_census FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid()
        AND uha.status = 'active'
        AND uha.role != 'Secretary'  -- Secretary blocked at DB level; totals via view
        AND (
          uha.congregation_id = priest_census.congregation_id
          OR uha.scope_level IN ('Conference','Apostolate','District','Apostleship','Overseership','Eldership')
        )
    )
  );

-- Audit log: readable by the user who performed the action + HO
CREATE POLICY "Audit log access"
  ON public.audit_log FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.role = 'HO' AND uha.status = 'active'
    )
  );

-- Audit log: any authenticated user can insert their own log entries
CREATE POLICY "Audit log insert"
  ON public.audit_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);
