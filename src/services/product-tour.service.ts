import { ProductTourStatus } from "@prisma/client";
import ProductTourRepo from "../repositories/product-tour.repository";
import AuthRepo from "../repositories/auth.repository";
import { PRODUCT_TOUR_TRACKS } from "../constants";

type TourState = {
  track: string;
  status: ProductTourStatus;
  archetype: string | null;
  currentStep: string | null;
  doneSteps: string[];
  updatedAt: Date | null;
};

/** Remembers where a user is in an onboarding tour. The app runs the tour itself (which step
 * comes next, what it highlights) and saves the whole state back after every move, so this is
 * a plain read/replace — no step logic lives here. */
export default class ProductTourSvc {
  /** A user who never touched the tour has no row yet — they read as NOT_STARTED. */
  static async get(userId: string, track: string): Promise<TourState> {
    const row = await ProductTourRepo.find(userId, track);
    if (!row) return { track, status: ProductTourStatus.NOT_STARTED, archetype: null, currentStep: null, doneSteps: [], updatedAt: null };
    return toState(row);
  }

  /** Replaces the saved state. A tour that isn't running has no current step, whatever was sent. */
  static async save(
    userId: string,
    track: string,
    input: { status: ProductTourStatus; archetype: string | null; currentStep: string | null; doneSteps: string[] },
  ): Promise<TourState> {
    const currentStep = input.status === ProductTourStatus.IN_PROGRESS ? input.currentStep : null;
    const row = await ProductTourRepo.upsert(userId, track, { ...input, currentStep, doneSteps: [...new Set(input.doneSteps)] });
    if (isFinished(input.status)) await completeOnboardingIfToursFinished(userId);
    return toState(row);
  }
}

function isFinished(status: ProductTourStatus) {
  return status === ProductTourStatus.COMPLETED || status === ProductTourStatus.DISMISSED;
}

/** Onboarding is done once every page tour has been completed or dismissed. One-way: replaying
 * a tour later doesn't put the user back into onboarding. */
async function completeOnboardingIfToursFinished(userId: string) {
  const finished = await ProductTourRepo.countFinished(userId, PRODUCT_TOUR_TRACKS);
  if (finished === PRODUCT_TOUR_TRACKS.length) await AuthRepo.setOnboardingCompleted(userId);
}

function toState(row: {
  track: string;
  status: ProductTourStatus;
  archetype: string | null;
  currentStep: string | null;
  doneSteps: string[];
  updatedAt: Date;
}): TourState {
  return {
    track: row.track,
    status: row.status,
    archetype: row.archetype,
    currentStep: row.currentStep,
    doneSteps: row.doneSteps,
    updatedAt: row.updatedAt,
  };
}
