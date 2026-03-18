-- Migration 008: Drop legacy tables that have been migrated to shared messages.db
-- Run AFTER migrations 006 and 007 have been applied by init-db.js.
--
-- outreaches   -> migrated to msgs.messages (project='2step', direction='outbound')
-- conversations -> migrated to msgs.messages (project='2step', message_type='reply')
-- followups    -> no data migration needed; follow-up messages are now generated
--                 at proposals time and stored directly in msgs.messages with
--                 message_type='followup1' or 'followup2'

BEGIN IMMEDIATE;

DROP TABLE IF EXISTS outreaches;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS followups;

COMMIT;
