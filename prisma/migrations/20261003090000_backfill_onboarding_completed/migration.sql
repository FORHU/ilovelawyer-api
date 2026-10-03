-- Users who had already finished every page tour (completed or dismissed) before the flag was
-- ever set. Keep the track list in sync with PRODUCT_TOUR_TRACKS.
UPDATE "User" SET "onboardingCompleted" = true
WHERE "onboardingCompleted" = false
  AND "id" IN (
    SELECT "userId" FROM "ProductTour"
    WHERE "track" IN ('consultation', 'cases', 'library', 'calendar', 'studio', 'terminal')
      AND "status" IN ('COMPLETED', 'DISMISSED')
    GROUP BY "userId"
    HAVING COUNT(*) = 6
  );
