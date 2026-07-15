-- ═══════════════════════════════════════════════════════════════════════════════
-- PURGE ALL DATA (run BEFORE seed_live.sql)
-- Order matters: delete children first to avoid FK violations
-- Does NOT delete auth.users — only app data tables
-- ═══════════════════════════════════════════════════════════════════════════════

TRUNCATE public.cashbook_attachment CASCADE;
TRUNCATE public.cashbook_line_item CASCADE;
TRUNCATE public.cashbook_period CASCADE;
TRUNCATE public.priest_census_log CASCADE;
TRUNCATE public.priest_census CASCADE;
TRUNCATE public.officers CASCADE;
TRUNCATE public.user_hierarchy_access CASCADE;
TRUNCATE public.ho_district_assignments CASCADE;
TRUNCATE public.congregations CASCADE;
TRUNCATE public.hierarchy_levels CASCADE;

-- Done. All app tables are empty. Run seed_live.sql next.
