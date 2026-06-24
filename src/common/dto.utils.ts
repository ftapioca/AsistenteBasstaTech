import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

export function validateDto<T extends object>(
  cls: new () => T,
  payload: unknown,
): T {
  const instance = plainToInstance(cls, payload);
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    const messages = errors
      .flatMap((error) => Object.values(error.constraints ?? {}))
      .join(', ');

    throw new BadRequestException(messages || 'Invalid payload');
  }

  return instance;
}
