-- chat-wonder-v2-api's CW-7 tool-override bridge (deepseek-reasoner/deepseek-chat tool calls)
-- went live without a provider value of its own, so every DeepSeek row was recorded as OPENAI.
-- Postgres requires ALTER TYPE ... ADD VALUE to not be used in the same transaction that adds
-- it; nothing else in this migration references 'DEEPSEEK', so it's safe in one transaction.
-- AlterEnum
ALTER TYPE "LlmProvider" ADD VALUE 'DEEPSEEK';
