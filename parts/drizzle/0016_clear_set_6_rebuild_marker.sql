-- Correct set #6's record: it was started from the プラン作成 tab form
-- button (a fresh creation by contract) but was recorded as a rebuild
-- of set #5 purely because a finished set for the same park and visit
-- date existed. Clear the rebuild marker so every surface (tab badge,
-- generating/failure wording, chat status answers) treats it as the
-- fresh creation it was. The "(3)" title prefix stays — same-title
-- numbering is a separate disambiguation mechanism. Guarded to the
-- exact recorded state (id 6, rebuilt_from_set_id 5) so the statement
-- is a no-op anywhere that state does not hold.
UPDATE `plan_sets` SET `rebuilt_from_set_id` = NULL WHERE `id` = 6 AND `rebuilt_from_set_id` = 5;
