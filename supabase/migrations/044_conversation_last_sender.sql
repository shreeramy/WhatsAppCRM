-- ============================================================
-- conversations.last_message_sender — who sent the latest message
-- ('customer' | 'agent' | 'bot'). Powers the Inbox "Unreplied" filter:
-- a conversation is waiting on us when the customer spoke last.
--
-- Maintained by a trigger on messages so every writer (webhook, inbox
-- send, automations, flows, broadcasts, public API) is covered without
-- touching each code path.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_sender TEXT
    CHECK (last_message_sender IN ('customer', 'agent', 'bot')),
  ADD COLUMN IF NOT EXISTS last_message_sender_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION track_conversation_last_sender()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations
  SET last_message_sender = NEW.sender_type,
      last_message_sender_at = COALESCE(NEW.created_at, NOW())
  WHERE id = NEW.conversation_id
    AND (
      last_message_sender_at IS NULL
      OR COALESCE(NEW.created_at, NOW()) >= last_message_sender_at
    );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a message insert over this bookkeeping.
  RAISE WARNING 'track_conversation_last_sender failed for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION track_conversation_last_sender() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_message_track_last_sender ON messages;
CREATE TRIGGER on_message_track_last_sender
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION track_conversation_last_sender();

-- Backfill from each conversation's latest message.
UPDATE conversations c
SET last_message_sender = lm.sender_type,
    last_message_sender_at = lm.created_at
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_type, created_at
  FROM messages
  ORDER BY conversation_id, created_at DESC
) lm
WHERE lm.conversation_id = c.id
  AND c.last_message_sender IS NULL;
