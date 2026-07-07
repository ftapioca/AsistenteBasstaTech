import { Priority, TaskScope } from '@prisma/client';

export type AiIntent =
  | 'CREATE_TASK'
  | 'LIST_TODAY_TASKS'
  | 'LIST_PENDING_TASKS'
  | 'LIST_COMPLETED_TASKS'
  | 'LIST_FAMILY_TASKS'
  | 'COMPLETE_TASK'
  | 'DELETE_TASK'
  | 'HELP'
  | 'UNKNOWN';

export type AiInterpretation = {
  intent: AiIntent;
  title?: string | null;
  description?: string | null;
  scope?: TaskScope | null;
  priority?: Priority | null;
  dueDate?: string | null;
  taskIndex?: number | null;
};

export type AiTranscription = {
  text: string;
  lowConfidence: boolean;
};
