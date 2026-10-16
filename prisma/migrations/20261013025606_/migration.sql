/*
  Warnings:

  - You are about to alter the column `title` on the `Consultation` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(60)`.

*/
-- AlterTable
ALTER TABLE "Consultation" ALTER COLUMN "title" SET DATA TYPE VARCHAR(60);
