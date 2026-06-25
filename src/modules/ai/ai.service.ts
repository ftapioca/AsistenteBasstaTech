import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Priority, TaskScope } from '@prisma/client';
import { DateTime } from 'luxon';
import OpenAI from 'openai';
import { z } from 'zod';
import { AiInterpretation } from './ai.types';

const nullableEnum = (values: string[]) => ({
  anyOf: [{ type: 'string', enum: values }, { type: 'null' }],
});

const interpretationSchema = z.object({
  intent: z.enum([
    'CREATE_TASK',
    'LIST_TODAY_TASKS',
    'LIST_PENDING_TASKS',
    'LIST_COMPLETED_TASKS',
    'LIST_FAMILY_TASKS',
    'COMPLETE_TASK',
    'DELETE_TASK',
    'HELP',
    'UNKNOWN',
  ]),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  scope: z.nativeEnum(TaskScope).nullable().optional(),
  priority: z.nativeEnum(Priority).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  taskIndex: z.number().int().nullable().optional(),
});

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client?: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async interpretMessage(
    message: string,
    context?: { timezone?: string; currentDateTimeIso?: string },
  ): Promise<AiInterpretation> {
    if (!this.client) {
      return this.heuristicInterpretation(message);
    }

    try {
      const timezone =
        context?.timezone ||
        this.configService.get<string>('DEFAULT_TIMEZONE', 'America/Santiago');
      const currentDateTimeIso =
        context?.currentDateTimeIso || DateTime.now().setZone(timezone).toISO();

      const response = await this.client.responses.create({
        model: this.configService.get<string>('OPENAI_MODEL', 'gpt-5.4-mini'),
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'Eres un parser de intenciones para un bot familiar de tareas.',
                  'Responde solo JSON valido. No ejecutes acciones.',
                  'Usa intent=UNKNOWN si falta certeza.',
                  `Zona horaria de referencia: ${timezone}.`,
                  `Fecha/hora actual de referencia: ${currentDateTimeIso}.`,
                  'Si entregas dueDate, debe ser una fecha ISO 8601 completa con zona horaria.',
                  'Debes resolver expresiones relativas en espanol como "manana", "el viernes", "en la tarde", "a las 18:00" usando la fecha de referencia.',
                  'Si dices "en la tarde" y no hay hora exacta, usa 15:00:00.',
                  'Si la prioridad esta explicita como alta/media/baja, mapearla a HIGH/MEDIUM/LOW.',
                  'El title debe ser breve y limpio; no incluyas en el title fragmentos como "prioridad alta" o fechas si pueden ir estructurados.',
                  'Si no puedes determinar la fecha con certeza, usa dueDate=null.',
                ].join(' '),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: message,
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'task_intent',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                intent: {
                  type: 'string',
                  enum: [
                    'CREATE_TASK',
                    'LIST_TODAY_TASKS',
                    'LIST_PENDING_TASKS',
                    'LIST_COMPLETED_TASKS',
                    'LIST_FAMILY_TASKS',
                    'COMPLETE_TASK',
                    'DELETE_TASK',
                    'HELP',
                    'UNKNOWN',
                  ],
                },
                title: { type: ['string', 'null'] },
                description: { type: ['string', 'null'] },
                scope: nullableEnum(['PERSONAL', 'FAMILY']),
                priority: nullableEnum(['LOW', 'MEDIUM', 'HIGH']),
                dueDate: { type: ['string', 'null'] },
                taskIndex: { type: ['integer', 'null'] },
              },
              required: [
                'intent',
                'title',
                'description',
                'scope',
                'priority',
                'dueDate',
                'taskIndex',
              ],
            },
          },
        },
      });

      const raw = response.output_text;
      if (!raw) {
        throw new Error('OpenAI no devolvio texto estructurado.');
      }

      return interpretationSchema.parse(JSON.parse(raw));
    } catch (error) {
      const errorObject =
        error && typeof error === 'object'
          ? (error as { status?: unknown; message?: unknown })
          : undefined;
      const details = errorObject
        ? JSON.stringify(
            {
              status: errorObject.status,
              message:
                typeof errorObject.message === 'string'
                  ? errorObject.message
                  : String(error),
            },
            null,
            2,
          )
        : String(error);
      this.logger.warn(`OpenAI fallback triggered: ${details}`);
      return this.heuristicInterpretation(message);
    }
  }

  private heuristicInterpretation(message: string): AiInterpretation {
    const text = message.trim();
    const lowered = text.toLowerCase();

    if (['/ayuda', 'ayuda'].includes(lowered)) {
      return { intent: 'HELP' };
    }

    if (['/hoy', 'hoy'].includes(lowered)) {
      return { intent: 'LIST_TODAY_TASKS' };
    }

    if (['/pendientes', 'pendientes'].includes(lowered)) {
      return { intent: 'LIST_PENDING_TASKS' };
    }

    if (
      ['/listas', 'listas', '/completadas', 'completadas'].includes(lowered)
    ) {
      return { intent: 'LIST_COMPLETED_TASKS' };
    }

    if (['/familiares', 'familiares'].includes(lowered)) {
      return { intent: 'LIST_FAMILY_TASKS' };
    }

    const completeMatch = lowered.match(/^(\/hecho|hecho)\s+(\d+)$/);
    if (completeMatch) {
      return {
        intent: 'COMPLETE_TASK',
        taskIndex: Number(completeMatch[2]),
      };
    }

    const deleteMatch = lowered.match(/^(\/eliminar|eliminar)\s+(\d+)$/);
    if (deleteMatch) {
      return {
        intent: 'DELETE_TASK',
        taskIndex: Number(deleteMatch[2]),
      };
    }

    const familyPrefix = /^tarea familiar:\s*/i;
    const scope = familyPrefix.test(text)
      ? TaskScope.FAMILY
      : TaskScope.PERSONAL;
    const title = text.replace(familyPrefix, '').trim();
    if (!title) {
      return { intent: 'UNKNOWN' };
    }

    return {
      intent: 'CREATE_TASK',
      title,
      description: null,
      scope,
      priority: Priority.MEDIUM,
      dueDate: lowered.includes('mañana')
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : null,
    };
  }
}
