# Tech: JW Cashbook v4

## Database Design v4
1.  hierarchy: org structure only. No people.
2.  officers: id, congregation_id, officer_code, name, role[Priest,Underdeacon]
3.  user_profiles: id, email, phone, role, status (active, inactive), datefrom, dateto
4.  user_hierarchy_access: maps user to hierarchy_id
5.  user_officer_access: maps Treasurer/Chair to officers they can capture for
6.  cashbook_period: id, congregation_id, year, month, week, service, status
7.  cashbook_line_item: id, period_id, section, officer_id, type, count, amount
8.  cashbook_attachment: id, line_item_id, url, proof_status

## Key Functions
`get_week_number(date)`: Returns week 1-5 based on "2nd Sunday = Week1" rule
`can_capture_period(cong_id, year, month, week, service)`: Checks prev week approved


## RLS 

1.  Treasurer/Chairperson: 
    can INSERT/UPDATE line_items 
    WHERE period.congregation_id IN (user's mapped congregations) 
    AND period.status = 'Draft'
    
2.  Auditor: 
    can UPDATE cashbook_period.status to 'AuditApproved' or 'Rejected'
    WHERE period.congregation_id IN (user's mapped congregations)
    AND period.status = 'SubmittedForAudit'

3.  Elder: 
    can UPDATE status to 'SubmittedToHO' 
    WHERE all weeks in month = 'AuditApproved' for that congregation

4.  Secretary: 
    can SELECT from cashbook_period and cashbook_line_item 
    WHERE status IN ('SubmittedToHO', 'HOReviewed')
    NO access to cashbook_attachment table

5.  HO/Overseer/Apostle: 
    can SELECT all tables using recursive hierarchy function

## Special RLS Case: Cashbook Submission
If a congregation has no user with role='Treasurer', the Chairperson for that congregation_id must be allowed to INSERT into cashbook_period and cashbook_line_item.
Policy: `submitted_by IN (treasurer_id OR chairperson_id for congregation)`

## Performance
Materialized view: mtd_totals_by_congregation
Index: (congregation_id, year, month, week, service)
