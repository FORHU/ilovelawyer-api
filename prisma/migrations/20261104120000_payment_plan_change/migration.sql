-- A lawyer's scheduled downgrade: the lower tier and the Stripe Subscription Schedule that moves the
-- subscription onto it at the end of the paid period (PaymentPlanBillingSvc.changePlan).

-- AlterTable
ALTER TABLE "PaymentPlanSubscription" ADD COLUMN     "scheduledPaymentPlanId" TEXT,
ADD COLUMN     "stripeScheduleId" TEXT;
