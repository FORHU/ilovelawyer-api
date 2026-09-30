-- Canonicalize every User.email to trimmed + lowercase, matching normalizeEmail() in
-- src/utils/auth.utils.ts, which every auth lookup/insert now goes through. Must ship in the
-- same release as that code: once lookups are normalized, a row still stored in mixed case
-- would be unreachable by login/forgot-password/Google.
--
-- Refuses to run (instead of silently picking a winner) if two accounts differ only by case
-- or surrounding whitespace. Resolve each such group by hand first — keep the verified/ACTIVE
-- account that owns the org and data, and rename or delete the other — then re-deploy. Find
-- them with:
--   SELECT lower(btrim(email)) AS canonical, array_agg(id), array_agg(email)
--   FROM "User" GROUP BY 1 HAVING count(*) > 1;
DO $$
DECLARE
  collisions INTEGER;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT lower(btrim(email)) FROM "User" GROUP BY 1 HAVING count(*) > 1
  ) dupes;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'normalize_user_emails: % email(s) collide case-insensitively; resolve them manually before migrating', collisions;
  END IF;
END $$;

UPDATE "User" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
