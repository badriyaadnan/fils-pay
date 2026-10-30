-- Creates an API key for Alpha Retail Co for the load test, and prints it once.
-- يسوي مفتاح API لتاجر Alpha عشان اختبار الضغط، ويطبعه مرة وحدة.
-- Only the SHA-256 hash is stored, exactly like apiKeys/issue.ts.
-- نخزن الـ hash بس، نفس طريقة apiKeys/issue.ts بالضبط.
-- Run / التشغيل:
--   docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay -At < loadtest/create_key.sql
WITH k AS (SELECT 'fp_live_' || md5(random()::text || clock_timestamp()::text) AS raw),
ins AS (
  INSERT INTO api_keys (merchant_id, key_prefix, key_hash, label, created_by)
  SELECT '9972daab-2c86-459f-9d78-3fe1be4e3280', left(raw, 16),
         encode(sha256(convert_to(raw, 'UTF8')), 'hex'), 'load test',
         (SELECT id FROM merchant_users
           WHERE merchant_id = '9972daab-2c86-459f-9d78-3fe1be4e3280' AND role = 'owner' LIMIT 1)
  FROM k
  RETURNING id)
SELECT raw FROM k, ins;