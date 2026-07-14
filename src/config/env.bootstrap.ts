import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const DEFAULT_ENV_FILE = '.env';

export function bootstrapEnvironment() {
  const envFilePath = process.env.ENV_FILE?.trim() || DEFAULT_ENV_FILE;
  const absolutePath = resolve(process.cwd(), envFilePath);

  if (!existsSync(absolutePath)) {
    return {
      envFilePath,
      absolutePath,
    };
  }

  const parsed = parse(readFileSync(absolutePath));

  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }

  return {
    envFilePath,
    absolutePath,
  };
}
