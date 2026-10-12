/** Loaded before every spec (package.json "test" --require), next to the security audit double.
 * LlmUsageSvc.record will run inside many services the specs exercise with stubbed repos; without
 * this it would write real rows to the database in .env. LlmUsageRepo.create is replaced with an
 * in-memory no-op; a spec that asserts on usage rows stubs LlmUsageRepo.create (or
 * LlmUsageSvc.record) itself, and its usual stash/restore puts this double back. */
import LlmUsageRepo from "../../src/repositories/llm-usage.repository";

const repo = LlmUsageRepo as any;
repo.create = async (data: object) => ({ id: "test-llm-usage-row", createdAt: new Date(), ...data });
