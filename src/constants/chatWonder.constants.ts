export const SESSION_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
export const LEGAL_TAG = "[legal ai]";
/** Legal persona sends `__END__` first, then `[STRUCTURED_DATA]` (timeline + mind map)
 * on a second LLM call, then `[DONE]`. Wait this long after `__END__` for that frame. */
export const STRUCTURED_DATA_WAIT_MS = 45_000;
