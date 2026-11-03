-- The business policy allows a Cartola team to belong to only one POINT FFC profile.
-- This unique index makes that rule atomic across API instances and concurrent requests.
-- Do not delete or reassign legacy duplicates automatically: this migration intentionally
-- fails if TIME_ID is already present for multiple users so the conflict can be reviewed.
ALTER TABLE `TIME_USUARIO`
  DROP INDEX `TIME_USUARIO_TIME_ID_idx`,
  ADD UNIQUE INDEX `TIME_USUARIO_TIME_ID_key` (`TIME_ID`);
