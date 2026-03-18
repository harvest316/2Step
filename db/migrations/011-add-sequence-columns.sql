-- Migration 011: Add sequence_step and scheduled_send_at to messages table
--
-- Expands the 3-touch system (outreach + followup1 + followup2) to an 8-touch
-- cadence over 28 days. Each message gets a sequence_step (1-8) and a
-- scheduled_send_at timestamp that enforces the cadence spacing.
--
-- Because messages live in the shared messages.db (ATTACHed as msgs), this
-- migration must be run against messages.db directly. The init-db.js runner
-- handles ATTACH automatically.
--
-- Changes to msgs.messages:
--   ADD COLUMN sequence_step   INTEGER  -- 1-8 touch position in the sequence
--   ADD COLUMN scheduled_send_at TEXT   -- ISO datetime when this message becomes eligible to send
--
-- Also relaxes the message_type CHECK to include touch1..touch8.
-- SQLite cannot ALTER CHECK constraints, so we leave the old CHECK in place
-- and use sequence_step as the canonical touch identifier going forward.
-- message_type will be set to 'outreach' for touch1, 'followup' for touch2-7,
-- and 'breakup' for touch8 — all valid under the existing CHECK if we add them.
--
-- Strategy: Since SQLite doesn't support ALTER COLUMN to change CHECK constraints,
-- we add the new columns and rely on sequence_step (1-8) as the authoritative
-- touch number. The message_type column retains backward compatibility.

-- Add sequence_step column (nullable for backward compat with existing messages)
ALTER TABLE msgs.messages ADD COLUMN sequence_step INTEGER;

-- Add scheduled_send_at column
ALTER TABLE msgs.messages ADD COLUMN scheduled_send_at TEXT;

-- Index for the outreach stage query: find messages ready to send
CREATE INDEX IF NOT EXISTS msgs.idx_messages_scheduled
  ON messages(scheduled_send_at)
  WHERE scheduled_send_at IS NOT NULL AND sent_at IS NULL;

-- Index for sequence queries: find all touches for a site
CREATE INDEX IF NOT EXISTS msgs.idx_messages_sequence
  ON messages(project, site_id, sequence_step)
  WHERE sequence_step IS NOT NULL;

-- Backfill sequence_step for existing messages based on message_type
UPDATE msgs.messages SET sequence_step = 1 WHERE message_type = 'outreach' AND sequence_step IS NULL AND project = '2step';
UPDATE msgs.messages SET sequence_step = 2 WHERE message_type = 'followup1' AND sequence_step IS NULL AND project = '2step';
UPDATE msgs.messages SET sequence_step = 3 WHERE message_type = 'followup2' AND sequence_step IS NULL AND project = '2step';
