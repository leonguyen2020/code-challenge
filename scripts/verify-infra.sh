#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Verifies the local infrastructure stack is not merely *running* but actually
# usable and correctly hardened.
#
#   ./scripts/verify-infra.sh
#
# Exits non-zero if any check fails, so it can be wired into CI.
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Run: cp .env.example .env" >&2
  exit 1
fi
set -a; . ./.env; set +a

PASS=0; FAIL=0
chk() {
  if [[ "$2" == "$3" ]]; then printf '  \033[32mPASS\033[0m  %s\n' "$1"; ((PASS++))
  else printf '  \033[31mFAIL\033[0m  %s (got: %q want: %q)\n' "$1" "$2" "$3"; ((FAIL++)); fi
}
psq() { docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
          psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "$1" 2>&1; }
rcl() { docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" "$@" 2>&1; }

echo "=== PostgreSQL (server_version: $(psq 'SHOW server_version;')) ==="
chk "server responds"           "$(psq 'SELECT 1;')" "1"
chk "auth = scram-sha-256"      "$(psq "SELECT CASE WHEN rolpassword LIKE 'SCRAM-SHA-256%' THEN 'scram' ELSE 'weak' END FROM pg_authid WHERE rolname='$POSTGRES_USER';")" "scram"
chk "pgcrypto installed"        "$(psq "SELECT extname FROM pg_extension WHERE extname='pgcrypto';")" "pgcrypto"
chk "pg_trgm installed"         "$(psq "SELECT extname FROM pg_extension WHERE extname='pg_trgm';")" "pg_trgm"
chk "gen_random_uuid works"     "$(psq 'SELECT length(gen_random_uuid()::text);')" "36"
chk "PUBLIC CREATE revoked"     "$(psq "SELECT has_schema_privilege('public','public','CREATE');")" "f"
psq "CREATE TABLE IF NOT EXISTS _verify(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);" >/dev/null
psq "TRUNCATE _verify; INSERT INTO _verify(name) VALUES ('alpha'),('beta'),('gamma');" >/dev/null
chk "insert+select round-trip"  "$(psq 'SELECT count(*) FROM _verify;')" "3"
chk "trigram similarity works"  "$(psq "SELECT count(*) FROM _verify WHERE name % 'alpah';")" "1"
chk "transaction rollback"      "$(psq 'BEGIN; DELETE FROM _verify; ROLLBACK; SELECT count(*) FROM _verify;' | tail -1)" "3"
# NOTE: the output is captured into a variable first. Piping psql straight
# into grep would let psql's deliberate non-zero exit poison the pipeline
# status under `set -o pipefail`, producing a false negative.
NN_OUT="$(psq 'INSERT INTO _verify(name) VALUES (NULL);')"
chk "NOT NULL enforced"         "$(grep -q 'not-null' <<<"$NN_OUT" && echo enforced || echo IGNORED)" "enforced"
psq "DROP TABLE _verify;" >/dev/null
PG_BAD_PW="$(docker compose exec -T -e PGPASSWORD=definitely_wrong postgres psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c 'SELECT 1;' 2>&1 || true)"
chk "pg: wrong password rejected" "$(grep -qiE 'authentication failed|password' <<<"$PG_BAD_PW" && echo denied || echo allowed)" "denied"

echo "=== Redis (version: $(rcl INFO server | grep -m1 redis_version | tr -d '\r' | cut -d: -f2)) ==="
chk "ping"                      "$(rcl ping)" "PONG"
rcl SET verify:k hello >/dev/null
chk "set/get round-trip"        "$(rcl GET verify:k)" "hello"
rcl SETEX verify:ttl 60 v >/dev/null
chk "TTL honoured"              "$(rcl TTL verify:ttl)" "60"
rcl DEL verify:board >/dev/null; rcl ZADD verify:board 100 alice 250 bob 175 carol >/dev/null
chk "sorted-set leaderboard"    "$(rcl ZREVRANGE verify:board 0 0)" "bob"
rcl DEL verify:n >/dev/null; rcl INCRBY verify:n 5 >/dev/null
chk "atomic INCR"               "$(rcl INCRBY verify:n 7)" "12"
chk "pub/sub enabled"           "$(rcl PUBLISH verify:ch msg)" "0"
chk "AOF enabled"               "$(docker compose exec -T redis sh -c 'grep -c "^appendonly yes" /tmp/redis.conf')" "1"
chk "AOF files on disk"         "$(docker compose exec -T redis sh -c 'ls /data/appendonlydir >/dev/null 2>&1 && echo yes || echo no')" "yes"
RD_NOAUTH="$(docker compose exec -T redis redis-cli PING 2>&1 || true)"
chk "redis: unauthenticated rejected" "$(grep -q NOAUTH <<<"$RD_NOAUTH" && echo denied || echo allowed)" "denied"
RD_BAD_PW="$(docker compose exec -T redis redis-cli --no-auth-warning -a wrongpass PING 2>&1 || true)"
chk "redis: wrong password rejected" "$(grep -qiE 'WRONGPASS|invalid' <<<"$RD_BAD_PW" && echo denied || echo allowed)" "denied"
chk "FLUSHALL disabled"         "$(rcl FLUSHALL | grep -qi 'unknown command' && echo blocked || echo ENABLED)" "blocked"
chk "CONFIG disabled"           "$(rcl CONFIG SET maxmemory 1gb | grep -qi 'unknown command' && echo blocked || echo ENABLED)" "blocked"
chk "DEBUG disabled"            "$(rcl DEBUG SLEEP 0 | grep -qi 'unknown command' && echo blocked || echo ENABLED)" "blocked"
chk "maxmemory cap applied"     "$(docker compose exec -T redis sh -c 'grep -c "^maxmemory 256mb" /tmp/redis.conf')" "1"
chk "password not in cmdline"   "$(docker inspect "${COMPOSE_PROJECT_NAME:-code-challenge}-redis" --format '{{json .Config.Cmd}}' | grep -q "$REDIS_PASSWORD" && echo LEAKED || echo hidden)" "hidden"
rcl DEL verify:k verify:ttl verify:board verify:n >/dev/null

echo "=== Network exposure ==="
chk "postgres on loopback"      "$(docker compose port postgres 5432 | cut -d: -f1)" "127.0.0.1"
chk "redis on loopback"         "$(docker compose port redis 6379 | cut -d: -f1)" "127.0.0.1"
chk "no wildcard listener"      "$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(5432|6379)' | grep -c '\*:' | tr -d ' ')" "0"
chk "no-new-privileges (pg)"    "$(docker inspect "${COMPOSE_PROJECT_NAME:-code-challenge}-postgres" --format '{{json .HostConfig.SecurityOpt}}' | grep -c no-new-privileges)" "1"
chk "no-new-privileges (redis)" "$(docker inspect "${COMPOSE_PROJECT_NAME:-code-challenge}-redis" --format '{{json .HostConfig.SecurityOpt}}' | grep -c no-new-privileges)" "1"

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit $(( FAIL > 0 ))
