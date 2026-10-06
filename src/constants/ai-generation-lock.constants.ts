// A job still waiting in the queue has no heartbeat yet. Past this age, such a lock is treated as
// abandoned (the message was lost) and silently reclaimed rather than blocking every future attempt.
export const STALE_AFTER_MS = 10 * 60 * 1000;

// While a job's work runs, AiGenerationLockSvc.finishWith stamps AiGenerationJob.heartbeatAt this
// often. A run that stops stamping for HEARTBEAT_STALE_AFTER_MS was lost to an API restart or
// crash, however long legitimate runs of its kind take — the analysis refresh can run for many
// minutes, but it never goes this long without a heartbeat.
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const HEARTBEAT_STALE_AFTER_MS = 2 * 60 * 1000;
