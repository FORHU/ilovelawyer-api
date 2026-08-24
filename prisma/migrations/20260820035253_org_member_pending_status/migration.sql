-- CreateEnum
CREATE TYPE "OrganizationMemberStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- AlterTable
ALTER TABLE "OrganizationMember" ADD COLUMN     "status" "OrganizationMemberStatus" NOT NULL DEFAULT 'ACCEPTED',
ALTER COLUMN "role" SET DEFAULT 'OWNER';
