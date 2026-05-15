-- AUTO-010: persist deterministic root-cause clustering output for run failures
ALTER TABLE runs ADD COLUMN rootCauses TEXT;
