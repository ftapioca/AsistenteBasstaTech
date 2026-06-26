import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Priority, TaskScope, UserRole } from '@prisma/client';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { Telegram } from 'telegraf';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/database/prisma.service';

type TelegramApiCall = {
  method: string;
  payload: Record<string, unknown>;
};

describe('Telegram webhook flows (e2e)', () => {
  jest.setTimeout(30000);

  let app: INestApplication;
  let prisma: PrismaService;
  let telegramApiCalls: TelegramApiCall[];
  let updateId = 1;
  let messageId = 1;

  const originalEnv = {
    databaseUrl: process.env.DATABASE_URL,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    renderExternalUrl: process.env.RENDER_EXTERNAL_URL,
    openAiKey: process.env.OPENAI_API_KEY,
  };
  const testSchema = `e2e_${Date.now()}`;

  beforeAll(() => {
    process.env.DATABASE_URL = buildTestDatabaseUrl(
      originalEnv.databaseUrl ?? '',
      testSchema,
    );
    execSync('npx prisma db push --skip-generate', {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'pipe',
    });

    jest
      .spyOn(Telegram.prototype, 'callApi')
      .mockImplementation(async function mockTelegramApiCall(
        method: string,
        payload: Record<string, unknown>,
      ) {
        telegramApiCalls.push({ method, payload });

        if (method === 'getMe') {
          return {
            id: 999001,
            is_bot: true,
            first_name: 'Test Bot',
            username: 'test_family_bot',
          } as never;
        }

        if (method === 'sendMessage') {
          return {
            message_id: messageId++,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: payload.chat_id,
              type: 'private',
            },
            text: payload.text,
          };
        }

        return true as never;
      });
  });

  afterAll(() => {
    jest.restoreAllMocks();
    process.env.DATABASE_URL = originalEnv.databaseUrl;
    process.env.TELEGRAM_BOT_TOKEN = originalEnv.telegramBotToken;
    process.env.TELEGRAM_WEBHOOK_URL = originalEnv.telegramWebhookUrl;
    process.env.TELEGRAM_WEBHOOK_SECRET = originalEnv.telegramWebhookSecret;
    process.env.RENDER_EXTERNAL_URL = originalEnv.renderExternalUrl;
    process.env.OPENAI_API_KEY = originalEnv.openAiKey;
  });

  beforeEach(async () => {
    telegramApiCalls = [];
    updateId = 1;
    messageId = 1;

    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://example.test/telegram';
    process.env.TELEGRAM_WEBHOOK_SECRET = '';
    process.env.RENDER_EXTERNAL_URL = '';
    process.env.OPENAI_API_KEY = '';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
    await resetDatabase(prisma);
  });

  afterEach(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
    await app.close();
  });

  it('/health responde ok', async () => {
    const server = app.getHttpServer() as Parameters<typeof request>[0];

    await request(server).get('/').expect(200).expect({
      service: 'Bot Asistente Familiar',
      status: 'ok',
    });
  });

  it('crea una tarea por wizard con nota opcional', async () => {
    const user = await createLinkedUser(prisma, {
      telegramUserId: '1001',
      telegramChatId: '2001',
    });

    await sendMessageUpdate('/nueva', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('Vamos a crear una tarea.');

    await sendMessageUpdate('Comprar pan', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('¿La tarea es personal o familiar?');

    await sendCallbackUpdate('wizard:scope:personal', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('¿Para cuándo es?');

    await sendCallbackUpdate('wizard:due:none', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('¿Quieres agregar una nota a la tarea?');

    await sendCallbackUpdate('wizard:note:yes', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('Escribe la nota');

    await sendMessageUpdate('Comprar pan integral y leche', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('¿Que prioridad tiene?');

    await sendCallbackUpdate('wizard:priority:high', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('Asi quedaria la tarea');
    expect(lastSentText()).toContain('Nota: Comprar pan integral y leche');

    await sendCallbackUpdate('wizard:confirm', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('Listo. Agregue');

    const createdTask = await prisma.task.findFirst({
      where: {
        familyId: user.familyId,
        title: 'Comprar pan',
      },
    });

    expect(createdTask).toMatchObject({
      scope: TaskScope.PERSONAL,
      priority: Priority.HIGH,
      description: 'Comprar pan integral y leche',
    });
  });

  it('permite editar el tipo de tarea desde contenido', async () => {
    const user = await createLinkedUser(prisma, {
      telegramUserId: '1002',
      telegramChatId: '2002',
    });
    const task = await prisma.task.create({
      data: {
        familyId: user.familyId,
        createdByUserId: user.id,
        assignedToUserId: user.id,
        title: 'Revisar presupuesto',
        scope: TaskScope.PERSONAL,
        priority: Priority.MEDIUM,
      },
    });

    await sendMessageUpdate('/editar', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('¿Que tarea quieres editar?');

    await sendCallbackUpdate('edit:select:1', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('Elige un area para continuar.');

    await sendCallbackUpdate(`edit:section:content:${task.id}`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('Editar contenido');
    expect(lastEditedText()).toContain('Tipo:');

    await sendCallbackUpdate(`edit:field:scope:${task.id}`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('Editar tipo de "Revisar presupuesto"');

    await sendCallbackUpdate(`edit:scope:set:${task.id}:family`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('👪 Familiar');

    const updatedTask = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(updatedTask.scope).toBe(TaskScope.FAMILY);
  });

  it('permite ver una tarea y confirmar su completado', async () => {
    const user = await createLinkedUser(prisma, {
      telegramUserId: '1003',
      telegramChatId: '2003',
    });
    const task = await prisma.task.create({
      data: {
        familyId: user.familyId,
        createdByUserId: user.id,
        assignedToUserId: user.id,
        title: 'Cerrar propuesta',
        description: 'Enviar version final al cliente',
        scope: TaskScope.PERSONAL,
        priority: Priority.HIGH,
      },
    });

    await sendMessageUpdate('/pendientes', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastSentText()).toContain('Estas son tus tareas pendientes');

    await sendCallbackUpdate('view:start', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('¿Que tarea quieres revisar?');

    await sendCallbackUpdate('view:select:1', {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('Detalle de tarea');
    expect(lastEditedText()).toContain('Cerrar propuesta');

    await sendCallbackUpdate(`view:complete:ask:${task.id}`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('Confirmar completado');

    await sendCallbackUpdate(`view:complete:cancel:${task.id}`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    expect(lastEditedText()).toContain('Detalle de tarea');

    await sendCallbackUpdate(`view:complete:ask:${task.id}`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });
    await sendCallbackUpdate(`view:complete:confirm:${task.id}`, {
      chatId: Number(user.telegramChatId),
      telegramUserId: Number(user.telegramUserId),
    });

    expect(lastSentText()).toContain('Listo, tarea completada.');

    const completedTask = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(completedTask.status).toBe('COMPLETED');
    expect(completedTask.completedAt).not.toBeNull();
  });

  it('permite traspasar la administracion familiar a otro integrante', async () => {
    const admin = await createLinkedUser(prisma, {
      telegramUserId: '1006',
      telegramChatId: '2006',
    });
    const member = await prisma.user.create({
      data: {
        familyId: admin.familyId,
        name: 'Ana Miembro',
        phoneNumber: '56910060006',
        telegramUserId: '11006',
        telegramChatId: '21006',
        role: UserRole.USER,
        timezone: 'America/Santiago',
      },
    });

    await sendMessageUpdate('👨‍👩‍👧 Editar familia', {
      chatId: Number(admin.telegramChatId),
      telegramUserId: Number(admin.telegramUserId),
    });
    expect(lastSentText()).toContain('Gestion de');

    await sendCallbackUpdate('family:start_transfer', {
      chatId: Number(admin.telegramChatId),
      telegramUserId: Number(admin.telegramUserId),
    });
    expect(lastEditedText()).toContain('Traspasar administracion');
    expect(lastEditedText()).toContain('Ana Miembro');

    await sendCallbackUpdate(`family:transfer:select:${member.id}`, {
      chatId: Number(admin.telegramChatId),
      telegramUserId: Number(admin.telegramUserId),
    });
    expect(lastEditedText()).toContain('Confirmar traspaso');

    await sendCallbackUpdate(`family:transfer:confirm:${member.id}`, {
      chatId: Number(admin.telegramChatId),
      telegramUserId: Number(admin.telegramUserId),
    });
    expect(lastSentText()).toContain('ahora es quien administra la familia');

    const refreshedAdmin = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
    });
    const refreshedMember = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
    });

    expect(refreshedAdmin.role).toBe(UserRole.USER);
    expect(refreshedMember.role).toBe(UserRole.FAMILY_ADMIN);
  });

  it('confirma la creacion de familia para un contacto nuevo usando HTML', async () => {
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    const chatId = 2004;
    const telegramUserId = 1004;

    await sendMessageUpdate('/start', {
      chatId,
      telegramUserId,
    });
    expect(allSentTexts().join('\n')).toContain('comparte tu numero');

    await request(server)
      .post('/telegram/webhook')
      .send({
        update_id: updateId++,
        message: {
          message_id: messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type: 'private',
          },
          from: {
            id: telegramUserId,
            is_bot: false,
            first_name: 'Felipe',
          },
          contact: {
            phone_number: '+56997078331',
            first_name: 'Felipe',
            user_id: telegramUserId,
          },
        },
      })
      .expect(200);

    expect(lastSentText()).toContain('No encontre una cuenta existente');
    expect(lastSentText()).toContain('Escribe el nombre que quieres para tu familia');
    expect(lastSentPayload().parse_mode).toBe('HTML');

    await sendMessageUpdate('Bassta Family DEV', {
      chatId,
      telegramUserId,
    });

    expect(lastSentText()).toContain('La familia se creara como');
    expect(lastSentText()).toContain('Responde "si" para continuar');

    await sendMessageUpdate('si', {
      chatId,
      telegramUserId,
    });

    expect(lastSentText()).toContain('quedaste como administrador');
    expect(lastSentPayload().reply_markup).toBeDefined();

    await sendCallbackUpdate('family:add_member', {
      chatId,
      telegramUserId,
    });

    expect(lastSentText()).toContain('Link de invitacion familiar');
    expect(lastSentText()).toContain(
      'https://t.me/test_family_bot?start=join-family-',
    );

    const createdUser = await prisma.user.findFirstOrThrow({
      where: {
        telegramUserId: String(telegramUserId),
      },
      include: {
        family: true,
      },
    });

    expect(createdUser.name).toBe('Felipe');
    expect(createdUser.family.name).toBe('Bassta Family DEV');

    const invitedChatId = 2005;
    const invitedTelegramUserId = 1005;

    await sendMessageUpdate(`/start join-family-${createdUser.familyId}`, {
      chatId: invitedChatId,
      telegramUserId: invitedTelegramUserId,
    });
    expect(allSentTexts().join('\n')).toContain('Te invitaron a unirte');

    await sendContactUpdate(
      {
        phoneNumber: '+56911112222',
        firstName: 'Ana',
      },
      {
        chatId: invitedChatId,
        telegramUserId: invitedTelegramUserId,
      },
    );
    expect(lastSentText()).toContain('Te agregare a la familia');

    await sendMessageUpdate('si', {
      chatId: invitedChatId,
      telegramUserId: invitedTelegramUserId,
    });
    expect(lastSentText()).toContain(
      'Quedaste vinculado a la familia Bassta Family DEV',
    );

    const invitedUser = await prisma.user.findFirstOrThrow({
      where: {
        telegramUserId: String(invitedTelegramUserId),
      },
      include: {
        family: true,
      },
    });

    expect(invitedUser.familyId).toBe(createdUser.familyId);
    expect(invitedUser.family.name).toBe('Bassta Family DEV');
  });

  async function sendMessageUpdate(
    text: string,
    options: { chatId: number; telegramUserId: number },
  ) {
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    const entities = text.startsWith('/')
      ? [
          {
            offset: 0,
            length: text.split(' ')[0].length,
            type: 'bot_command',
          },
        ]
      : undefined;

    await request(server)
      .post('/telegram/webhook')
      .send({
        update_id: updateId++,
        message: {
          message_id: messageId++,
          date: Math.floor(Date.now() / 1000),
          text,
          entities,
          chat: {
            id: options.chatId,
            type: 'private',
          },
          from: {
            id: options.telegramUserId,
            is_bot: false,
            first_name: 'Tester',
          },
        },
      })
      .expect(200);
  }

  async function sendCallbackUpdate(
    data: string,
    options: { chatId: number; telegramUserId: number },
  ) {
    const server = app.getHttpServer() as Parameters<typeof request>[0];

    await request(server)
      .post('/telegram/webhook')
      .send({
        update_id: updateId++,
        callback_query: {
          id: `cb-${updateId}`,
          from: {
            id: options.telegramUserId,
            is_bot: false,
            first_name: 'Tester',
          },
          data,
          message: {
            message_id: messageId++,
            date: Math.floor(Date.now() / 1000),
            text: 'inline message',
            chat: {
              id: options.chatId,
              type: 'private',
            },
          },
        },
      })
      .expect(200);
  }

  async function sendContactUpdate(
    contact: { phoneNumber: string; firstName: string },
    options: { chatId: number; telegramUserId: number },
  ) {
    const server = app.getHttpServer() as Parameters<typeof request>[0];

    await request(server)
      .post('/telegram/webhook')
      .send({
        update_id: updateId++,
        message: {
          message_id: messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: options.chatId,
            type: 'private',
          },
          from: {
            id: options.telegramUserId,
            is_bot: false,
            first_name: contact.firstName,
          },
          contact: {
            phone_number: contact.phoneNumber,
            first_name: contact.firstName,
            user_id: options.telegramUserId,
          },
        },
      })
      .expect(200);
  }

  function lastSentText() {
    const sentMessages = telegramApiCalls.filter(
      (call) => call.method === 'sendMessage',
    );
    return String(sentMessages.at(-1)?.payload.text ?? '');
  }

  function lastSentPayload() {
    const sentMessages = telegramApiCalls.filter(
      (call) => call.method === 'sendMessage',
    );
    return sentMessages.at(-1)?.payload ?? {};
  }

  function allSentTexts() {
    return telegramApiCalls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload.text ?? ''));
  }

  function lastEditedText() {
    const editedMessages = telegramApiCalls.filter(
      (call) => call.method === 'editMessageText',
    );
    return String(editedMessages.at(-1)?.payload.text ?? '');
  }
});

async function createLinkedUser(
  prisma: PrismaService,
  input: { telegramUserId: string; telegramChatId: string },
) {
  const family = await prisma.family.create({
    data: {
      name: 'Familia Test',
      settings: {
        create: {},
      },
    },
  });

  return prisma.user.create({
    data: {
      familyId: family.id,
      name: 'Felipe Test',
      phoneNumber: `5699${input.telegramUserId}`,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      telegramUsername: 'tester',
      role: UserRole.FAMILY_ADMIN,
      timezone: 'America/Santiago',
      dailyBriefingTime: '08:30',
    },
  });
}

async function resetDatabase(prisma: PrismaService) {
  await prisma.dailyBriefingLog.deleteMany();
  await prisma.chatContext.deleteMany();
  await prisma.task.deleteMany();
  await prisma.user.deleteMany();
  await prisma.settings.deleteMany();
  await prisma.family.deleteMany();
}

function buildTestDatabaseUrl(databaseUrl: string, schema: string) {
  const sanitized = databaseUrl.replace(/^"|"$/g, '');
  const url = new URL(sanitized);
  url.searchParams.set('schema', schema);
  return url.toString();
}
