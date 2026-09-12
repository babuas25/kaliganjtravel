-- 0135 was already applied to normalize legacy Completed requests. Restore the
-- original settlement timestamp for those now-Approved terminal outcomes so
-- the Manage table continues to show the actual action time.

update public.ticket_management_requests
   set status_changed_at = completed_at
 where status = 'approved'
   and terminal_outcome in ('refunded', 'reissued', 'voided')
   and completed_at is not null;
