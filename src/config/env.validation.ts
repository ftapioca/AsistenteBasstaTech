import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default(
      'postgresql://postgres:postgres@localhost:5432/bot_asistente_familiar?schema=public',
    ),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  DEFAULT_TIMEZONE: z.string().default('America/Santiago'),
  DEFAULT_DAILY_BRIEFING_TIME: z.string().default('08:30'),
  REMINDER_MINUTES_BEFORE: z.coerce.number().int().positive().default(30),
});

export function validateEnvironment(config: Record<string, unknown>) {
  return envSchema.parse(config);
}
