-- #158: tappable reply candidates for the question an assistant IntakeMessage turn just asked,
-- straight off CW's [INTAKE_SUGGESTIONS] frame. Empty array default, never null -- CW sends []
-- explicitly when it has nothing confident to suggest, and this column mirrors that.
-- AlterTable
ALTER TABLE "IntakeMessage" ADD COLUMN "suggestions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
