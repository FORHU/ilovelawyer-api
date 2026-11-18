-- KR Lawyer Application and firm details (Korea tenant, plan step 7). See LawyerKrRegistration and
-- Organization in schema.prisma. Additive only: no existing row changes.

-- AlterTable: KR firm details, both optional (KR_FIRM_TYPES; 사업자등록번호, 10 digits).
ALTER TABLE "Organization" ADD COLUMN     "businessRegistrationNumber" TEXT,
ADD COLUMN     "firmType" TEXT;

-- CreateTable: the KR part of a Lawyer Application, keyed like the UK and PH ones.
CREATE TABLE "LawyerKrRegistration" (
    "userId" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "localBar" TEXT,
    "qualificationRoute" TEXT,
    "qualificationCohort" INTEGER,
    "specialties" TEXT[],
    "registeredOn" DATE,

    CONSTRAINT "LawyerKrRegistration_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "LawyerKrRegistration" ADD CONSTRAINT "LawyerKrRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LawyerClientProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
