-- ═══════════════════════════════════════════════════════════════════════════════
-- DATA CLEANUP: Remove orphan line items with null officer_id 
-- that should have had an officer (Members/Officers sections)
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM public.cashbook_line_item 
WHERE officer_id IS NULL 
  AND item_type IN ('EFT', 'Cash', 'DirectDeposit')
  AND section IN ('Members', 'Officers');
