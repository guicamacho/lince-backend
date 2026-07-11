-- Team-invite resend + cooldown (2026-07-11). `last_invited_at` is the timestamp of the last
-- invitation EMAIL sent to this person; a conditional UPDATE against it enforces a per-email
-- cooldown so invite/resend can't be used to spam an inbox. Per-person (people), so it survives
-- a membership removal — remove + immediate re-invite is still cooldown-limited.
alter table people add column last_invited_at timestamptz;
