import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Priority, TaskScope } from '@prisma/client';

export class CreateTaskDto {
  @IsString()
  @MaxLength(140)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsEnum(TaskScope)
  scope!: TaskScope;

  @IsEnum(Priority)
  priority!: Priority;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}
