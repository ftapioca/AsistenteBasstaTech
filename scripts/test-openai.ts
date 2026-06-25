import 'dotenv/config';
import OpenAI from 'openai';
import { DateTime } from 'luxon';

type Interpretation = {
  intent: string;
  title: string | null;
  description: string | null;
  scope: 'PERSONAL' | 'FAMILY' | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  dueDate: string | null;
  taskIndex: number | null;
};

type TestCase = {
  name: string;
  message: string;
  assert: (result: Interpretation) => string[];
};

const nullableEnum = (values: string[]) => ({
  anyOf: [{ type: 'string', enum: values }, { type: 'null' }],
});

const timezone = process.env.DEFAULT_TIMEZONE || 'America/Santiago';
const currentDateTimeIso =
  DateTime.now().setZone(timezone).set({
    hour: 10,
    minute: 0,
    second: 0,
    millisecond: 0,
  }).toISO() || undefined;

const cases: TestCase[] = [
  {
    name: 'Lista pendientes',
    message: 'muéstrame los pendientes',
    assert: (result) => {
      const errors: string[] = [];
      if (result.intent !== 'LIST_PENDING_TASKS') {
        errors.push(`intent esperado LIST_PENDING_TASKS y recibi ${result.intent}`);
      }
      return errors;
    },
  },
  {
    name: 'Tarea familiar simple',
    message: 'Tarea familiar: comprar comida para el perro mañana a las 19:00 con prioridad alta',
    assert: (result) => {
      const errors: string[] = [];
      if (result.intent !== 'CREATE_TASK') {
        errors.push(`intent esperado CREATE_TASK y recibi ${result.intent}`);
      }
      if (result.scope !== 'FAMILY') {
        errors.push(`scope esperado FAMILY y recibi ${String(result.scope)}`);
      }
      if (result.priority !== 'HIGH') {
        errors.push(`priority esperado HIGH y recibi ${String(result.priority)}`);
      }
      if (!result.dueDate) {
        errors.push('dueDate esperado con valor ISO y recibi null');
      }
      return errors;
    },
  },
  {
    name: 'Completar por indice',
    message: 'hecho 3',
    assert: (result) => {
      const errors: string[] = [];
      if (result.intent !== 'COMPLETE_TASK') {
        errors.push(`intent esperado COMPLETE_TASK y recibi ${result.intent}`);
      }
      if (result.taskIndex !== 3) {
        errors.push(`taskIndex esperado 3 y recibi ${String(result.taskIndex)}`);
      }
      return errors;
    },
  },
  {
    name: 'Caso complejo OpenAI',
    message:
      'Tarea familiar: coordinar controles de mi mamá este fin de semana; si no alcanzamos el sábado en la tarde, dejarlo para el domingo temprano. Que quede alta prioridad y recuérdame revisar bonos antes.',
    assert: (result) => {
      const errors: string[] = [];
      if (result.intent !== 'CREATE_TASK') {
        errors.push(`intent esperado CREATE_TASK y recibi ${result.intent}`);
      }
      if (result.scope !== 'FAMILY') {
        errors.push(`scope esperado FAMILY y recibi ${String(result.scope)}`);
      }
      if (result.priority !== 'HIGH') {
        errors.push(`priority esperado HIGH y recibi ${String(result.priority)}`);
      }
      if (!result.title || result.title.length < 8) {
        errors.push(`title demasiado pobre: ${String(result.title)}`);
      }
      if (result.dueDate !== null && !DateTime.fromISO(result.dueDate).isValid) {
        errors.push(`dueDate no es ISO valido: ${String(result.dueDate)}`);
      }
      return errors;
    },
  },
];

function buildPrompt(message: string) {
  return {
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    input: [
      {
        role: 'system' as const,
        content: [
          {
            type: 'input_text' as const,
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
              'El title debe ser breve y limpio; no incluyas en el title fechas ni prioridad si pueden ir estructuradas.',
              'Si no puedes determinar la fecha con certeza, usa dueDate=null.',
            ].join(' '),
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'input_text' as const,
            text: message,
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema' as const,
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
  };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  const client = new OpenAI({ apiKey });
  let failures = 0;

  console.log(`Usando modelo ${process.env.OPENAI_MODEL || 'gpt-5.4-mini'}`);
  console.log(`Timezone de referencia: ${timezone}`);
  console.log(`Fecha/hora de referencia: ${currentDateTimeIso}`);
  console.log('');

  for (const testCase of cases) {
    const response = await client.responses.create(buildPrompt(testCase.message));
    const raw = response.output_text || '';
    const parsed = JSON.parse(raw) as Interpretation;
    const errors = testCase.assert(parsed);

    console.log(`Caso: ${testCase.name}`);
    console.log(`Prompt: ${testCase.message}`);
    console.log(`Salida: ${raw}`);

    if (errors.length === 0) {
      console.log('Resultado: OK');
    } else {
      failures += 1;
      console.log('Resultado: FAIL');
      for (const error of errors) {
        console.log(`- ${error}`);
      }
    }

    console.log('');
  }

  if (failures > 0) {
    process.exitCode = 1;
    console.error(`OPENAI_TEST_FAILURES=${failures}`);
    return;
  }

  console.log('OPENAI_TEST_SUCCESS');
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
