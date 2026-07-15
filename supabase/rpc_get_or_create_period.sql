-- ═══════════════════════════════════════════════════════════════════════════════
-- RPC: get_or_create_period
-- Safely gets or creates a cashbook_period for a given congregation/week/service.
-- Avoids the "unable to load period" error when switching AM/PM.
-- Run in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_or_create_period(
  p_congregation_id UUID,
  p_year INT,
  p_month INT,
  p_week INT,
  p_service TEXT,
  p_user_id UUID
)
RETURNS public.cashbook_period
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result public.cashbook_period;
BEGIN
  -- Try to find existing period
  SELECT * INTO result
  FROM public.cashbook_period
  WHERE congregation_id = p_congregation_id
    AND year = p_year
    AND month = p_month
    AND week = p_week
    AND service = p_service;

  -- If not found, create it
  IF NOT FOUND THEN
    INSERT INTO public.cashbook_period (congregation_id, year, month, week, service, status, submitted_by)
    VALUES (p_congregation_id, p_year, p_month, p_week, p_service, 'Draft', p_user_id)
    RETURNING * INTO result;
  END IF;

  RETURN result;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.get_or_create_period TO authenticated;
