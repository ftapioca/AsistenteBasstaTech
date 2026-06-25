import 'dotenv/config';
import OpenAI from 'openai';

const nullableEnum = (values: string[]) => ({
  anyOf: [
    { type: 'string', enum: values },
    { type: 'null' },
  ],
});

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5.5';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  const client = new OpenAI({ apiKey });

  const response = await client.responses.create({
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Devuelve solo JSON valido para intenciones de tareas.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Comprar pan mañana',
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

  console.log(response.output_text || '(sin output_text)');
}

void main().catch((error: unknown) => {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? error.status
      : '';
  const message =
    error instanceof Error ? error.message : JSON.stringify(error, null, 2);
  console.error('OPENAI_TEST_ERROR', status, message);
  process.exit(1);
});
