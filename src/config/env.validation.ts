import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

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
  ALLOW_TELEGRAM_POLLING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TELEGRAM_WEBHOOK_URL: optionalUrl,
  TELEGRAM_WEBHOOK_SECRET: optionalNonEmptyString,
  RENDER_EXTERNAL_URL: optionalUrl,
  DEFAULT_TIMEZONE: z.string().default('America/Santiago'),
  DEFAULT_DAILY_BRIEFING_TIME: z.string().default('08:30'),
  DAILY_BRIEFING_GRACE_MINUTES: z.coerce.number().int().positive().default(240),
  REMINDER_MINUTES_BEFORE: z.coerce.number().int().positive().default(30),
  REMINDER_OVERDUE_GRACE_MINUTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30),
});

export function validateEnvironment(config: Record<string, unknown>) {
  const env = envSchema.parse(config);
  const databaseHost = readDatabaseHost(env.DATABASE_URL);
  const isLocalDatabase = ['localhost', '127.0.0.1', '::1'].includes(
    databaseHost,
  );
  const hasWebhookBase = Boolean(
    env.TELEGRAM_WEBHOOK_URL || env.RENDER_EXTERNAL_URL,
  );

  if (env.NODE_ENV === 'production' && isLocalDatabase) {
    throw new Error(
      'DATABASE_URL no puede apuntar a localhost cuando NODE_ENV=production.',
    );
  }

  if (hasWebhookBase && isLocalDatabase) {
    throw new Error(
      'DATABASE_URL no puede apuntar a localhost cuando el bot usa webhook. Usa una base remota o deja vacio TELEGRAM_WEBHOOK_URL/RENDER_EXTERNAL_URL para polling local.',
    );
  }

  return env;
}

function readDatabaseHost(databaseUrl: string) {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return '';
  }
}
