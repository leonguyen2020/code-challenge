-- ---------------------------------------------------------------------------
-- Runs once, on first initialisation of an empty data directory.
-- Idempotent so a re-run (e.g. after `docker compose down -v`) is safe.
-- ---------------------------------------------------------------------------

-- UUID generation (gen_random_uuid) for primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram indexes, used later for case-insensitive partial-match filters.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Revoke the default PUBLIC create-privilege on the public schema so only
-- explicitly granted roles can create objects (least privilege).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
