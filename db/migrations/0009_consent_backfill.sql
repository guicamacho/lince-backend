-- 0009_consent_backfill.sql — data fix, no DDL.
-- Orgs bootstrapped before consent capture shipped (bootstrap.ts began writing a
-- consent.accepted audit row per org on 2026-07-04) have no consent record. Give every
-- such org exactly one row, clearly marked as a backfill: the payload records that
-- contemporaneous acceptance was NOT captured — this is a record-gap closure, not a
-- fabricated acceptance. Versions mirror CONSENT_VERSIONS (all v1 at backfill time).
insert into audit_log (org_id, actor_type, actor_id, event, payload)
select o.id,
       'system',
       null,
       'consent.accepted',
       jsonb_build_object(
         'documents', jsonb_build_array(
           jsonb_build_object('id', 'avenia_terms',        'version', 'v1'),
           jsonb_build_object('id', 'lince_channel_terms', 'version', 'v1'),
           jsonb_build_object('id', 'lgpd_consent',        'version', 'v1')
         ),
         'backfilled', true,
         'note', 'org predates consent capture; contemporaneous acceptance was not recorded (migration 0009)'
       )
  from orgs o
 where not exists (
        select 1 from audit_log a
         where a.org_id = o.id and a.event = 'consent.accepted'
       );
