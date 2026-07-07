import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Priority, TaskScope } from '@prisma/client';
import { DateTime } from 'luxon';
import OpenAI from 'openai';
import { z } from 'zod';
import { AiInterpretation, AiTranscription } from './ai.types';

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
      return;
    }

    this.logger.warn(
      'OPENAI_API_KEY no configurado. La transcripcion de voz queda deshabilitada y el parser de texto usara fallback heuristico.',
    );
  }

  async transcribeVoiceNote(input: {
    audio: Buffer;
    fileName?: string;
    mimeType?: string;
    language?: string;
  }): Promise<AiTranscription> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY no configurado para transcripcion.');
    }

    const configuredModel = this.configService.get<string>(
      'OPENAI_TRANSCRIPTION_MODEL',
    );
    const candidateModels = [
      configuredModel?.trim(),
      'gpt-4o-mini-transcribe-2025-12-15',
      'gpt-4o-mini-transcribe',
      'gpt-4o-transcribe',
      'whisper-1',
    ].filter((model, index, list): model is string =>
      Boolean(model) && list.indexOf(model) === index,
    );

    let lastError: string | null = null;

    for (const model of candidateModels) {
      try {
        this.logger.log(`Intentando transcripcion con modelo ${model}`);
        return await this.requestTranscription(input, model, apiKey);
      } catch (error) {
        lastError = this.formatOpenAiError(error);
        this.logger.warn(
          `Fallo transcripcion con ${model}. Probando siguiente fallback. ${lastError}`,
        );
      }
    }

    throw new Error(
      `Fallo transcripcion para todos los modelos configurados. Ultimo error: ${lastError ?? 'sin detalle'}`,
    );
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
                  'Frases como "recordarme", "recuérdame", "recordar", "acuérdame" o "no olvidar" normalmente representan CREATE_TASK aunque la fecha o el detalle sea ambiguo.',
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
    const title = text
      .replace(familyPrefix, '')
      .replace(
        /^(recordarme|recu[eé]rdame|recordar|acu[eé]rdame|no olvidar)\s+/i,
        '',
      )
      .trim();
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

  private isLowConfidenceTranscription(
    logprobs?: Array<{ logprob?: number }>,
  ) {
    if (!logprobs || logprobs.length === 0) {
      return false;
    }

    const values = logprobs
      .map((item) => item.logprob)
      .filter((value): value is number => typeof value === 'number');

    if (values.length === 0) {
      return false;
    }

    const averageLogprob =
      values.reduce((sum, value) => sum + value, 0) / values.length;

    return averageLogprob < -0.8;
  }

  private formatOpenAiError(error: unknown) {
    if (error && typeof error === 'object') {
      const candidate = error as { status?: unknown; message?: unknown };
      return JSON.stringify(
        {
          status: candidate.status,
          message:
            typeof candidate.message === 'string'
              ? candidate.message
              : String(error),
        },
        null,
        2,
      );
    }

    return String(error);
  }

  private async requestTranscription(
    input: {
      audio: Buffer;
      fileName?: string;
      mimeType?: string;
      language?: string;
    },
    model: string,
    apiKey: string,
  ): Promise<AiTranscription> {
    const form = new FormData();
    const bytes = new Uint8Array(input.audio);
    const file = new File([bytes], input.fileName ?? 'voice-note.ogg', {
      type: input.mimeType ?? 'audio/ogg',
    });

    form.append('file', file);
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('temperature', '0');

    if (input.language?.trim()) {
      form.append('language', input.language.trim());
    }

    this.logger.log(
      `Enviando audio a OpenAI. model=${model} bytes=${input.audio.byteLength} mime=${input.mimeType ?? 'audio/ogg'}`,
    );
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    const bodyText = await response.text();
    this.logger.log(
      `Respuesta de OpenAI transcriptions. model=${model} status=${response.status}`,
    );

    if (!response.ok) {
      throw new Error(
        JSON.stringify(
          {
            status: response.status,
            body: bodyText,
          },
          null,
          2,
        ),
      );
    }

    const payload = JSON.parse(bodyText) as { text?: string };
    const text = payload.text?.trim();

    if (!text) {
      throw new Error(
        `La transcripcion llego vacia. body=${bodyText.slice(0, 500)}`,
      );
    }

    return {
      text,
      lowConfidence: false,
    };
  }
}
