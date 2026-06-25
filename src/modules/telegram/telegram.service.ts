import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Priority, TaskScope, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { Update } from 'telegraf/types';
import { validateDto } from '../../common/dto.utils';
import { AiService } from '../ai/ai.service';
import { CreateTaskDto } from '../tasks/dto/create-task.dto';
import { TasksService } from '../tasks/tasks.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UsersService } from '../users/users.service';

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};

type TelegramChat = {
  id: number;
  type: string;
};

type BotReplyContext = {
  from: TelegramUser;
  chat: TelegramChat;
  reply: (text: string, extra?: unknown) => Promise<unknown>;
};

type BotTextContext = BotReplyContext & {
  message: {
    text: string;
  };
};

type BotContactContext = BotReplyContext & {
  message: {
    contact: {
      phone_number: string;
      first_name?: string;
      user_id?: number;
    };
  };
};

type DisplayTask = {
  title: string;
  dueDate: Date | null;
  scope: TaskScope;
  priority?: Priority;
};

type BotCallbackContext = BotReplyContext & {
  answerCbQuery: (text?: string) => Promise<unknown>;
  editMessageReplyMarkup: (markup?: unknown) => Promise<unknown>;
  editMessageText: (text: string, extra?: unknown) => Promise<unknown>;
};

type BotResponse =
  | string
  | {
      text: string;
      extra?: unknown;
    };

type BulkCallbackResult = {
  answerText?: string;
  editText?: string;
  editExtra?: unknown;
  clearMarkup?: boolean;
  reply?: BotResponse;
};

const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';
const MENU_NEW_TASK = '➕ Nueva tarea';
const MENU_TODAY = '📆 Hoy';
const MENU_PENDING = '📋 Pendientes';
const MENU_FAMILY = '👨‍👩‍👧 Familiares';
const MENU_COMPLETED = '✅ Listas';
const MENU_HELP = '❓ Ayuda';
const MENU_CANCEL = 'Cancelar';
const WIZARD_SCOPE_PERSONAL = 'Personal';
const WIZARD_SCOPE_FAMILY = 'Familiar';
const WIZARD_DUE_NONE = 'Sin fecha';
const WIZARD_PRIORITY_HIGH = 'Alta';
const WIZARD_PRIORITY_MEDIUM = 'Media';
const WIZARD_PRIORITY_LOW = 'Baja';
const WIZARD_CONFIRM_CREATE = 'Crear tarea';
const CALLBACK_WIZARD_SCOPE_PERSONAL = 'wizard:scope:personal';
const CALLBACK_WIZARD_SCOPE_FAMILY = 'wizard:scope:family';
const CALLBACK_WIZARD_DUE_NONE = 'wizard:due:none';
const CALLBACK_WIZARD_CANCEL = 'wizard:cancel';
const CALLBACK_WIZARD_PRIORITY_HIGH = 'wizard:priority:high';
const CALLBACK_WIZARD_PRIORITY_MEDIUM = 'wizard:priority:medium';
const CALLBACK_WIZARD_PRIORITY_LOW = 'wizard:priority:low';
const CALLBACK_WIZARD_CONFIRM = 'wizard:confirm';
const CALLBACK_BULK_START_COMPLETE = 'bulk:start:complete';
const CALLBACK_BULK_START_DELETE = 'bulk:start:delete';
const CALLBACK_BULK_CANCEL = 'bulk:cancel';
const CALLBACK_BULK_CONFIRM_COMPLETE = 'bulk:confirm:complete';
const CALLBACK_BULK_CONFIRM_DELETE = 'bulk:confirm:delete';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Telegraf;
  private transportMode: 'polling' | 'webhook' | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly tasksService: TasksService,
    private readonly aiService: AiService,
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN no configurado. Bot deshabilitado.');
      return;
    }

    this.bot = new Telegraf(token);
    this.registerHandlers();

    const webhookBaseUrl =
      this.configService.get<string>('TELEGRAM_WEBHOOK_URL') ||
      this.configService.get<string>('RENDER_EXTERNAL_URL');

    if (webhookBaseUrl) {
      this.transportMode = 'webhook';
      void this.configureWebhook(webhookBaseUrl);
      return;
    }

    this.transportMode = 'polling';
    void this.startPolling();
  }

  onModuleDestroy() {
    if (!this.bot || this.transportMode !== 'polling') {
      return;
    }

    try {
      this.bot.stop();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.warn(`No se pudo detener Telegram limpiamente: ${message}`);
    }
  }

  async sendText(chatId: string, text: string) {
    if (!this.bot) {
      return;
    }

    await this.bot.telegram.sendMessage(chatId, text);
  }

  async handleWebhookUpdate(update: Update, secretToken?: string) {
    if (!this.bot) {
      return;
    }

    const expectedSecret = this.configService.get<string>(
      'TELEGRAM_WEBHOOK_SECRET',
    );
    if (expectedSecret && secretToken !== expectedSecret) {
      throw new UnauthorizedException('Invalid Telegram webhook secret.');
    }

    await this.bot.handleUpdate(update);
  }

  private registerHandlers() {
    if (!this.bot) {
      return;
    }

    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('Este MVP solo soporta conversaciones privadas.');
        return;
      }

      await next();
    });

    this.bot.start(async (ctx) => {
      const typedCtx = ctx as unknown as BotReplyContext;
      await this.safeReply(typedCtx, this.handleStart(typedCtx));
    });

    this.bot.command('ayuda', async (ctx) => {
      await ctx.reply(this.helpMessage);
    });

    this.bot.command('crearusuario', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleCreateUser(typedCtx));
    });

    this.bot.command('nueva', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.startTaskWizard(typedCtx));
    });

    this.bot.command('hoy', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleListToday(typedCtx));
    });

    this.bot.command('pendientes', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleListPending(typedCtx));
    });

    this.bot.command('listas', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleListCompleted(typedCtx));
    });

    this.bot.command('familiares', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleListFamily(typedCtx));
    });

    this.bot.command('hecho', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleComplete(typedCtx));
    });

    this.bot.command('eliminar', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleDelete(typedCtx));
    });

    this.bot.on(message('contact'), async (ctx) => {
      const typedCtx = ctx as unknown as BotContactContext;
      await this.safeReply(typedCtx, this.handleContact(typedCtx));
    });

    this.bot.action(/^wizard:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleWizardCallback(typedCtx);
    });

    this.bot.action(/^bulk:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleBulkCallback(typedCtx);
    });

    this.bot.on(message('text'), async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      const text = typedCtx.message.text.trim();
      if (text.startsWith('/')) {
        return;
      }

      await this.safeReply(typedCtx, this.handleNaturalLanguage(typedCtx));
    });
  }

  private async startPolling() {
    if (!this.bot) {
      return;
    }

    try {
      await this.syncBotCommands();
      await this.bot.telegram.deleteWebhook({
        drop_pending_updates: false,
      });
      await this.bot.launch();
      this.logger.log('Telegram bot iniciado en polling.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`No se pudo iniciar Telegram: ${message}`);
    }
  }

  private async configureWebhook(baseUrl: string) {
    if (!this.bot) {
      return;
    }

    try {
      await this.syncBotCommands();
      const expectedSecret = this.configService.get<string>(
        'TELEGRAM_WEBHOOK_SECRET',
      );
      const webhookUrl = `${baseUrl.replace(/\/$/, '')}${TELEGRAM_WEBHOOK_PATH}`;

      await this.bot.telegram.setWebhook(webhookUrl, {
        drop_pending_updates: false,
        secret_token: expectedSecret,
      });

      this.logger.log(`Telegram bot iniciado en webhook: ${webhookUrl}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`No se pudo iniciar Telegram: ${message}`);
    }
  }

  private async handleStart(ctx: BotReplyContext) {
    const registeredUser = await this.usersService.findByTelegramUserId(
      String(ctx.from.id),
    );

    if (registeredUser) {
      return `Hola ${registeredUser.name}. Ya estas vinculado a la familia ${registeredUser.family.name}.\n\n${this.helpMessage}`;
    }

    await ctx.reply(
      'Para vincularte o crear tu familia, comparte tu numero usando el boton de contacto.',
      Markup.keyboard([[Markup.button.contactRequest('Compartir mi contacto')]])
        .oneTime()
        .resize(),
    );

    return 'Quedo atento a tu contacto para continuar.';
  }

  private async handleContact(ctx: BotContactContext) {
    const contact = ctx.message.contact;
    if (contact.user_id && contact.user_id !== ctx.from.id) {
      throw new BadRequestException(
        'Debes compartir tu propio contacto para vincularte.',
      );
    }

    const user = await this.usersService.linkTelegramAccount({
      phoneNumber: contact.phone_number,
      telegramUserId: String(ctx.from.id),
      telegramChatId: String(ctx.chat.id),
      telegramUsername: ctx.from.username,
      fallbackName: ctx.from.first_name || contact.first_name || 'Usuario',
    });

    await ctx.reply('Cuenta vinculada correctamente.', Markup.removeKeyboard());

    if (user.role === UserRole.FAMILY_ADMIN) {
      return `Bienvenido ${user.name}. Se creo ${user.family.name} y quedaste como administrador.\n\nUsa /crearusuario Nombre +56912345678 para agregar miembros.`;
    }

    return `Bienvenido ${user.name}. Quedaste vinculado a la familia ${user.family.name}.`;
  }

  private async handleCreateUser(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const raw = ctx.message.text.replace('/crearusuario', '').trim();
    const match = raw.match(/^(.+)\s+(\+?[1-9]\d{7,14})$/);

    if (!match) {
      throw new BadRequestException(
        'Formato invalido. Usa /crearusuario Nombre +56912345678',
      );
    }

    const dto = validateDto(CreateUserDto, {
      name: match[1].trim(),
      phoneNumber: match[2].trim(),
    });

    const createdUser = await this.usersService.createManagedUser(user.id, dto);
    return `Usuario ${createdUser.name} creado en la familia. Debe escribir /start y compartir su contacto para vincularse.`;
  }

  private async startTaskWizard(ctx: BotReplyContext): Promise<BotResponse> {
    await this.requireRegisteredUser(ctx);
    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'CREATE_TASK_WIZARD',
      step: 'TITLE',
      draft: {},
    });

    return {
      text: 'Vamos a crear una tarea.\n\nPrimero, escribe el titulo.\nEjemplo: Comprar remedios para mi mama.\n\nPuedes responder "Cancelar" en cualquier paso.',
    };
  }

  private async handleListToday(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listTodayTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse('today', tasks, true, true);
  }

  private async handleListPending(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listPendingTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse('pending', tasks, true, true);
  }

  private async handleListFamily(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listFamilyTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse('family', tasks, true, true);
  }

  private async handleListCompleted(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listCompletedTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse('completed', tasks, false, false);
  }

  private async handleComplete(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const index = Number(ctx.message.text.replace('/hecho', '').trim());
    const task = await this.tasksService.completeTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return `Listo. Marque "${task.title}" como completada.`;
  }

  private async handleDelete(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const index = Number(ctx.message.text.replace('/eliminar', '').trim());
    const task = await this.tasksService.cancelTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return `Elimine "${task.title}" de tu lista.`;
  }

  private async handleNaturalLanguage(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const menuActionReply = await this.tryHandleMenuAction(ctx);
    if (menuActionReply) {
      return menuActionReply;
    }

    const wizardReply = await this.tryHandleTaskWizard(ctx, user.id);
    if (wizardReply) {
      return wizardReply;
    }

    const confirmationReply = await this.tryHandlePendingConfirmation(
      ctx,
      user.id,
    );
    if (confirmationReply) {
      return confirmationReply;
    }

    const timezone = this.usersService.resolveTimezone(user);
    const interpretation = await this.aiService.interpretMessage(
      ctx.message.text,
      {
        timezone,
        currentDateTimeIso:
          DateTime.now().setZone(timezone).toISO() ?? undefined,
      },
    );

    switch (interpretation.intent) {
      case 'LIST_TODAY_TASKS':
        return this.handleListToday(ctx);
      case 'LIST_PENDING_TASKS':
        return this.handleListPending(ctx);
      case 'LIST_COMPLETED_TASKS':
        return this.handleListCompleted(ctx);
      case 'LIST_FAMILY_TASKS':
        return this.handleListFamily(ctx);
      case 'COMPLETE_TASK':
        if (!interpretation.taskIndex) {
          throw new BadRequestException(
            'Indica el indice de la tarea a completar.',
          );
        }
        await this.tasksService.completeTaskByIndex(
          user.id,
          String(ctx.chat.id),
          interpretation.taskIndex,
        );
        return `Listo. Marque la tarea ${interpretation.taskIndex} como completada.`;
      case 'DELETE_TASK':
        if (!interpretation.taskIndex) {
          throw new BadRequestException(
            'Indica el indice de la tarea a eliminar.',
          );
        }
        await this.tasksService.cancelTaskByIndex(
          user.id,
          String(ctx.chat.id),
          interpretation.taskIndex,
        );
        return `Elimine la tarea ${interpretation.taskIndex} de tu lista.`;
      case 'HELP':
        return this.helpMessage;
      case 'CREATE_TASK': {
        const dto = validateDto(CreateTaskDto, {
          title: interpretation.title ?? ctx.message.text,
          description: interpretation.description ?? null,
          scope: interpretation.scope ?? TaskScope.PERSONAL,
          priority: interpretation.priority ?? Priority.MEDIUM,
          dueDate: this.normalizeDueDate(interpretation.dueDate),
        });
        return this.createTaskWithChecks(ctx, user.id, dto, ctx.message.text);
      }
      default:
        if (this.looksLikePotentialTask(ctx.message.text)) {
          const dto = validateDto(CreateTaskDto, {
            title: this.buildFallbackTaskTitle(ctx.message.text),
            description: null,
            scope: TaskScope.PERSONAL,
            priority: Priority.MEDIUM,
            dueDate: null,
          });
          await this.tasksService.setPendingAction(String(ctx.chat.id), {
            type: 'CREATE_TASK_CONFIRMATION',
            reason: 'AMBIGUOUS_DATE',
            dto,
          });
          return `Eso suena a tarea, pero no pude resolver bien la fecha o el detalle. Entendi "${dto.title}". ¿Quieres que la deje creada sin fecha? Responde si o no.`;
        }

        return 'No pude interpretar esa solicitud. Usa /ayuda para ver ejemplos.';
    }
  }

  private async requireRegisteredUser(ctx: BotReplyContext) {
    const user = await this.usersService.findByTelegramUserId(
      String(ctx.from.id),
    );
    if (!user) {
      throw new BadRequestException(
        'Tu cuenta no esta vinculada. Usa /start y comparte tu contacto.',
      );
    }
    return user;
  }

  private buildTaskListResponse(
    listType: 'today' | 'pending' | 'family' | 'completed',
    tasks: DisplayTask[],
    allowBulkComplete: boolean,
    allowBulkDelete: boolean,
  ): BotResponse {
    const text = this.formatTaskList(listType, tasks);
    const buttons = [];

    if (tasks.length > 0 && allowBulkComplete) {
      buttons.push(
        Markup.button.callback(
          '✅ Completar varias',
          CALLBACK_BULK_START_COMPLETE,
        ),
      );
    }

    if (tasks.length > 0 && allowBulkDelete) {
      buttons.push(
        Markup.button.callback(
          '🗑️ Eliminar varias',
          CALLBACK_BULK_START_DELETE,
        ),
      );
    }

    if (buttons.length === 0) {
      return text;
    }

    return {
      text,
      extra: Markup.inlineKeyboard([buttons]),
    };
  }

  private formatTaskList(
    listType: 'today' | 'pending' | 'family' | 'completed',
    tasks: DisplayTask[],
    timezone = this.configService.get<string>(
      'DEFAULT_TIMEZONE',
      'America/Santiago',
    ),
  ) {
    const headings: Record<typeof listType, string> = {
      today: 'Esto tienes para hoy',
      pending: 'Estas son tus tareas pendientes',
      family: 'Estas son las tareas familiares pendientes',
      completed: 'Estas son las tareas completadas',
    };

    if (tasks.length === 0) {
      return `${headings[listType]}\n\nNo hay nada por aqui.`;
    }

    if (listType === 'today' || listType === 'completed') {
      const lines = tasks.map(
        (task, index) =>
          `${index + 1}. ${this.formatTaskLine(task, timezone, false)}`,
      );
      return `${headings[listType]}\n\n${lines.join('\n')}`;
    }

    const now = DateTime.now().setZone(timezone);
    const today: string[] = [];
    const tomorrow: string[] = [];
    const futureByDay = new Map<string, string[]>();
    const noDate: string[] = [];

    tasks.forEach((task, index) => {
      const line = `${index + 1}. ${this.formatTaskLine(task, timezone, false)}`;
      if (!task.dueDate) {
        noDate.push(line);
        return;
      }

      const due = DateTime.fromJSDate(task.dueDate).setZone(timezone);
      if (due.hasSame(now, 'day')) {
        today.push(line);
        return;
      }

      if (due.hasSame(now.plus({ days: 1 }), 'day')) {
        tomorrow.push(line);
        return;
      }

      const bucketKey =
        due.startOf('day').toISODate() ?? due.toFormat('yyyy-LL-dd');
      const bucket = futureByDay.get(bucketKey) ?? [];
      bucket.push(line);
      futureByDay.set(bucketKey, bucket);
    });

    const sections = [headings[listType]];
    if (today.length > 0) {
      sections.push(`Hoy\n${today.join('\n')}`);
    }
    if (tomorrow.length > 0) {
      sections.push(`Mañana\n${tomorrow.join('\n')}`);
    }
    for (const [bucketKey, lines] of futureByDay.entries()) {
      const bucketDate = DateTime.fromISO(bucketKey, {
        zone: timezone,
      }).setLocale('es');
      sections.push(
        `${bucketDate.toFormat('cccc dd/LL').replace(/^./, (char) => char.toUpperCase())}\n${lines.join('\n')}`,
      );
    }
    if (noDate.length > 0) {
      sections.push(`Sin fecha\n${noDate.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  private async safeReply(ctx: BotReplyContext, handler: Promise<BotResponse>) {
    try {
      const reply = await handler;
      const payload = this.normalizeBotResponse(reply);
      const defaultExtra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(payload.text, payload.extra ?? defaultExtra);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      const extra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(message, extra);
    }
  }

  private normalizeBotResponse(reply: BotResponse) {
    if (typeof reply === 'string') {
      return { text: reply, extra: undefined };
    }

    return reply;
  }

  private normalizeDueDate(dueDate?: string | null) {
    if (!dueDate) {
      return null;
    }

    const parsed = new Date(dueDate);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  private detectTaskAmbiguity(message: string, dueDate: string | null) {
    if (dueDate) {
      return false;
    }

    const lowered = message.toLowerCase();
    return /(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|pasado mañana|fin de semana|en la tarde|en la mañana|en la noche|a las \d{1,2})/.test(
      lowered,
    );
  }

  private looksLikePotentialTask(message: string) {
    const lowered = message.trim().toLowerCase();
    return /(recordarme|recu[eé]rdame|recordar|acu[eé]rdame|no olvidar|tengo que|hay que|debo|necesito)/.test(
      lowered,
    );
  }

  private buildFallbackTaskTitle(message: string) {
    return message
      .trim()
      .replace(
        /^(recordarme|recu[eé]rdame|recordar|acu[eé]rdame|no olvidar)\s+/i,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async tryHandlePendingConfirmation(
    ctx: BotTextContext,
    userId: string,
  ) {
    const text = ctx.message.text.trim().toLowerCase();
    if (!['si', 'sí', 'no', 'cancelar'].includes(text)) {
      return null;
    }

    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'CREATE_TASK_CONFIRMATION') {
      return null;
    }

    await this.tasksService.clearPendingAction(String(ctx.chat.id));

    if (text === 'no' || text === 'cancelar') {
      return 'Listo, no hice ningun cambio.';
    }

    const task = await this.tasksService.createTaskForUser(
      userId,
      pendingAction.dto,
    );

    if (pendingAction.reason === 'AMBIGUOUS_DATE') {
      return `Listo. Agregue "${task.title}" sin fecha. Puedes verla en Pendientes.`;
    }

    return `Listo. Cree otra tarea igual: "${task.title}".`;
  }

  private async tryHandleMenuAction(ctx: BotTextContext) {
    const text = ctx.message.text.trim();

    switch (text) {
      case MENU_NEW_TASK:
        return this.startTaskWizard(ctx);
      case MENU_TODAY:
        return this.handleListToday(ctx);
      case MENU_PENDING:
        return this.handleListPending(ctx);
      case MENU_FAMILY:
        return this.handleListFamily(ctx);
      case MENU_COMPLETED:
        return this.handleListCompleted(ctx);
      case MENU_HELP:
        return this.helpMessage;
      default:
        return null;
    }
  }

  private async safeHandleWizardCallback(
    ctx: BotCallbackContext & {
      callbackQuery: { data?: string };
    },
  ) {
    try {
      const data = ctx.callbackQuery.data;
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }

      const reply = await this.handleWizardCallback(
        ctx,
        String(ctx.from.id),
        data,
      );
      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(undefined);

      if (!reply) {
        return;
      }

      const payload = this.normalizeBotResponse(reply);
      const defaultExtra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(payload.text, payload.extra ?? defaultExtra);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      await ctx.answerCbQuery(message);
    }
  }

  private async safeHandleBulkCallback(
    ctx: BotCallbackContext & {
      callbackQuery: { data?: string };
    },
  ) {
    try {
      const data = ctx.callbackQuery.data;
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }

      const result = await this.handleBulkCallback(
        ctx,
        String(ctx.from.id),
        data,
      );
      await ctx.answerCbQuery(result.answerText);

      if (result.editText) {
        await ctx.editMessageText(result.editText, result.editExtra);
      } else if (result.clearMarkup) {
        await ctx.editMessageReplyMarkup(undefined);
      }

      if (result.reply) {
        const payload = this.normalizeBotResponse(result.reply);
        const defaultExtra = await this.getDefaultReplyMarkup(ctx);
        await ctx.reply(payload.text, payload.extra ?? defaultExtra);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      await ctx.answerCbQuery(message);
    }
  }

  private async handleWizardCallback(
    ctx: BotReplyContext,
    userTelegramId: string,
    data: string,
  ): Promise<BotResponse | null> {
    const user = await this.usersService.findByTelegramUserId(userTelegramId);
    if (!user) {
      throw new BadRequestException(
        'Tu cuenta no esta vinculada. Usa /start y comparte tu contacto.',
      );
    }

    switch (data) {
      case CALLBACK_WIZARD_CANCEL:
        await this.tasksService.clearPendingAction(String(ctx.chat.id));
        return 'Listo, cancele la creacion de la tarea.';
      case CALLBACK_WIZARD_SCOPE_PERSONAL:
        return this.handleWizardInput(ctx, user.id, WIZARD_SCOPE_PERSONAL);
      case CALLBACK_WIZARD_SCOPE_FAMILY:
        return this.handleWizardInput(ctx, user.id, WIZARD_SCOPE_FAMILY);
      case CALLBACK_WIZARD_DUE_NONE:
        return this.handleWizardInput(ctx, user.id, WIZARD_DUE_NONE);
      case CALLBACK_WIZARD_PRIORITY_HIGH:
        return this.handleWizardInput(ctx, user.id, WIZARD_PRIORITY_HIGH);
      case CALLBACK_WIZARD_PRIORITY_MEDIUM:
        return this.handleWizardInput(ctx, user.id, WIZARD_PRIORITY_MEDIUM);
      case CALLBACK_WIZARD_PRIORITY_LOW:
        return this.handleWizardInput(ctx, user.id, WIZARD_PRIORITY_LOW);
      case CALLBACK_WIZARD_CONFIRM:
        return this.handleWizardInput(ctx, user.id, WIZARD_CONFIRM_CREATE);
      default:
        return null;
    }
  }

  private async handleBulkCallback(
    ctx: BotReplyContext,
    userTelegramId: string,
    data: string,
  ): Promise<BulkCallbackResult> {
    const user = await this.usersService.findByTelegramUserId(userTelegramId);
    if (!user) {
      throw new BadRequestException(
        'Tu cuenta no esta vinculada. Usa /start y comparte tu contacto.',
      );
    }

    if (data === CALLBACK_BULK_START_COMPLETE) {
      return this.startBulkTaskAction(ctx, 'COMPLETE');
    }

    if (data === CALLBACK_BULK_START_DELETE) {
      return this.startBulkTaskAction(ctx, 'DELETE');
    }

    if (data === CALLBACK_BULK_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cancelado',
        clearMarkup: true,
        reply: 'Listo, cancele la seleccion multiple.',
      };
    }

    if (data.startsWith('bulk:toggle:')) {
      const [, , mode, indexText] = data.split(':');
      return this.toggleBulkTaskSelection(
        ctx,
        mode === 'delete' ? 'DELETE' : 'COMPLETE',
        Number(indexText),
      );
    }

    if (data === CALLBACK_BULK_CONFIRM_COMPLETE) {
      return this.confirmBulkTaskAction(ctx, user.id, 'COMPLETE');
    }

    if (data === CALLBACK_BULK_CONFIRM_DELETE) {
      return this.confirmBulkTaskAction(ctx, user.id, 'DELETE');
    }

    return {
      answerText: undefined,
      clearMarkup: false,
    };
  }

  private async startBulkTaskAction(
    ctx: BotReplyContext,
    mode: 'COMPLETE' | 'DELETE',
  ) {
    const tasks = await this.tasksService.getTasksFromContext(
      String(ctx.chat.id),
    );
    if (tasks.length === 0) {
      throw new BadRequestException(
        'No hay una lista reciente con tareas para seleccionar.',
      );
    }

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'BULK_TASK_ACTION_WIZARD',
      mode,
      taskIds: tasks.map((task) => task.id),
      selectedTaskIds: [],
    });

    return {
      answerText: undefined,
      editText: this.formatBulkSelectionPrompt(mode, tasks, []),
      editExtra: this.buildBulkSelectionKeyboard(mode, tasks, []),
    };
  }

  private async toggleBulkTaskSelection(
    ctx: BotReplyContext,
    mode: 'COMPLETE' | 'DELETE',
    index: number,
  ) {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'BULK_TASK_ACTION_WIZARD') {
      throw new BadRequestException('No hay una seleccion multiple activa.');
    }

    const tasks = await this.tasksService.getTasksFromContext(
      String(ctx.chat.id),
    );
    const task = tasks[index - 1];
    if (!task) {
      throw new BadRequestException('Ese indice no existe en la lista actual.');
    }

    const selectedTaskIds = pendingAction.selectedTaskIds.includes(task.id)
      ? pendingAction.selectedTaskIds.filter((taskId) => taskId !== task.id)
      : [...pendingAction.selectedTaskIds, task.id];

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'BULK_TASK_ACTION_WIZARD',
      mode,
      taskIds: pendingAction.taskIds,
      selectedTaskIds,
    });

    return {
      answerText: selectedTaskIds.includes(task.id)
        ? 'Seleccionada'
        : 'Quitada',
      editText: this.formatBulkSelectionPrompt(mode, tasks, selectedTaskIds),
      editExtra: this.buildBulkSelectionKeyboard(mode, tasks, selectedTaskIds),
    };
  }

  private async confirmBulkTaskAction(
    ctx: BotReplyContext,
    userId: string,
    mode: 'COMPLETE' | 'DELETE',
  ) {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'BULK_TASK_ACTION_WIZARD') {
      throw new BadRequestException('No hay una seleccion multiple activa.');
    }

    if (pendingAction.selectedTaskIds.length === 0) {
      throw new BadRequestException('Selecciona al menos una tarea primero.');
    }

    await this.tasksService.clearPendingAction(String(ctx.chat.id));
    const tasks =
      mode === 'COMPLETE'
        ? await this.tasksService.completeTasksByIds(
            userId,
            pendingAction.selectedTaskIds,
          )
        : await this.tasksService.deleteTasksByIds(
            userId,
            pendingAction.selectedTaskIds,
          );

    const reply =
      mode === 'COMPLETE'
        ? `Listo. Marque ${tasks.length} tarea${tasks.length === 1 ? '' : 's'} como completada${tasks.length === 1 ? '' : 's'}.`
        : `Listo. Elimine ${tasks.length} tarea${tasks.length === 1 ? '' : 's'} de tu lista.`;

    return {
      answerText: 'Hecho',
      clearMarkup: true,
      reply,
    };
  }

  private async tryHandleTaskWizard(ctx: BotTextContext, userId: string) {
    return this.handleWizardInput(ctx, userId, ctx.message.text.trim());
  }

  private async handleWizardInput(
    ctx: BotReplyContext,
    userId: string,
    rawText: string,
  ): Promise<BotResponse | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'CREATE_TASK_WIZARD') {
      return null;
    }

    const text = rawText.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, cancele la creacion de la tarea.';
    }

    switch (pendingAction.step) {
      case 'TITLE':
        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'SCOPE',
          draft: {
            ...pendingAction.draft,
            title: text,
          },
        });
        return {
          text: '¿La tarea es personal o familiar?',
          extra: this.wizardScopeInlineKeyboard,
        };
      case 'SCOPE': {
        const scope = this.parseWizardScope(text);
        if (!scope) {
          throw new BadRequestException('Responde "Personal" o "Familiar".');
        }

        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'DUE_DATE',
          draft: {
            ...pendingAction.draft,
            scope,
          },
        });
        return {
          text: '¿Para cuando es? Escribe una fecha natural como "manana 18:00" o "el viernes en la tarde". Si prefieres, usa el boton "Sin fecha".',
          extra: this.wizardDueDateInlineKeyboard,
        };
      }
      case 'DUE_DATE': {
        const dueDate = await this.resolveWizardDueDate(text, userId);
        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'PRIORITY',
          draft: {
            ...pendingAction.draft,
            dueDate,
            dueDateInput: text,
          },
        });
        return {
          text: '¿Que prioridad tiene?',
          extra: this.wizardPriorityInlineKeyboard,
        };
      }
      case 'PRIORITY': {
        const priority = this.parseWizardPriority(text);
        if (!priority) {
          throw new BadRequestException('Responde "Alta", "Media" o "Baja".');
        }

        const draft = {
          ...pendingAction.draft,
          priority,
        };
        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'CONFIRM',
          draft,
        });
        return {
          text: this.formatTaskDraftSummary(draft),
          extra: this.wizardConfirmInlineKeyboard,
        };
      }
      case 'CONFIRM':
        if (
          lowered !== 'si' &&
          lowered !== 'sí' &&
          text !== WIZARD_CONFIRM_CREATE
        ) {
          throw new BadRequestException(
            'Responde "Crear tarea" o "si" para confirmar, o "Cancelar" para salir.',
          );
        }

        await this.tasksService.clearPendingAction(String(ctx.chat.id));
        return this.createTaskWithChecks(
          ctx,
          userId,
          validateDto(CreateTaskDto, {
            title: pendingAction.draft.title,
            description: null,
            scope: pendingAction.draft.scope ?? TaskScope.PERSONAL,
            priority: pendingAction.draft.priority ?? Priority.MEDIUM,
            dueDate: pendingAction.draft.dueDate ?? null,
          }),
          pendingAction.draft.dueDateInput ?? '',
        );
    }
  }

  private async createTaskWithChecks(
    ctx: BotReplyContext,
    userId: string,
    dto: CreateTaskDto,
    originalMessage: string,
  ) {
    const chatId = String(ctx.chat.id);
    const ambiguity = this.detectTaskAmbiguity(
      originalMessage,
      dto.dueDate ?? null,
    );
    if (ambiguity) {
      await this.tasksService.setPendingAction(chatId, {
        type: 'CREATE_TASK_CONFIRMATION',
        reason: 'AMBIGUOUS_DATE',
        dto,
      });
      return `No pude fijar una fecha exacta para "${dto.title}". Si quieres, la dejo creada sin fecha. Responde si o no.`;
    }

    const duplicateTask = await this.tasksService.findObviousDuplicateTask(
      userId,
      dto,
    );
    if (duplicateTask) {
      await this.tasksService.setPendingAction(chatId, {
        type: 'CREATE_TASK_CONFIRMATION',
        reason: 'DUPLICATE_TASK',
        dto,
        duplicateTaskTitle: duplicateTask.title,
      });
      return `Ya tienes una tarea muy parecida: "${duplicateTask.title}". Si aun asi quieres otra, responde si.`;
    }

    const task = await this.tasksService.createTaskForUser(userId, dto);
    const user = await this.usersService.requireActiveUser(userId);
    return `Listo. Agregue ${this.formatTaskCreatedSummary(
      task,
      this.usersService.resolveTimezone(user),
    )}`;
  }

  private async resolveWizardDueDate(text: string, userId: string) {
    if (text === WIZARD_DUE_NONE || text.trim().toLowerCase() === 'sin fecha') {
      return null;
    }

    const user = await this.usersService.requireActiveUser(userId);
    const timezone = this.usersService.resolveTimezone(user);
    const interpretation = await this.aiService.interpretMessage(
      `Tarea: placeholder. Fecha: ${text}`,
      {
        timezone,
        currentDateTimeIso:
          DateTime.now().setZone(timezone).toISO() ?? undefined,
      },
    );

    return this.normalizeDueDate(interpretation.dueDate);
  }

  private parseWizardScope(text: string) {
    const lowered = text.trim().toLowerCase();
    if (lowered === 'personal') {
      return TaskScope.PERSONAL;
    }

    if (lowered === 'familiar') {
      return TaskScope.FAMILY;
    }

    return null;
  }

  private parseWizardPriority(text: string) {
    const lowered = text.trim().toLowerCase();
    if (lowered === 'alta') {
      return Priority.HIGH;
    }

    if (lowered === 'media') {
      return Priority.MEDIUM;
    }

    if (lowered === 'baja') {
      return Priority.LOW;
    }

    return null;
  }

  private formatTaskDraftSummary(draft: {
    title?: string;
    scope?: TaskScope;
    dueDate?: string | null;
    dueDateInput?: string | null;
    priority?: Priority;
  }) {
    const timezone = this.configService.get<string>(
      'DEFAULT_TIMEZONE',
      'America/Santiago',
    );
    const dueDate = draft.dueDate
      ? DateTime.fromISO(draft.dueDate)
          .setZone(timezone)
          .toFormat('yyyy-LL-dd HH:mm')
      : 'Sin fecha';

    return [
      'Asi quedaria la tarea',
      `Titulo: ${draft.title ?? '-'}`,
      `Tipo: ${this.formatScopeLabel(draft.scope ?? TaskScope.PERSONAL)}`,
      `Vence: ${dueDate}`,
      `Prioridad: ${this.formatPriorityLabel(draft.priority ?? Priority.MEDIUM)}`,
      '',
      'Responde "Crear tarea" o "si" para confirmarla.',
    ].join('\n');
  }

  private formatTaskLine(
    task: DisplayTask,
    timezone: string,
    includeDate: boolean,
  ) {
    const badges = [
      this.formatScopeIcon(task.scope),
      this.formatPriorityBadge(task.priority),
    ]
      .filter(Boolean)
      .join(' ');
    const due = task.dueDate
      ? this.formatTaskDueText(task.dueDate, timezone, includeDate)
      : 'sin fecha';

    return `${badges} ${task.title} · ${due}`.trim();
  }

  private formatTaskDueText(
    dueDate: Date,
    timezone: string,
    includeDate: boolean,
  ) {
    const due = DateTime.fromJSDate(dueDate).setZone(timezone).setLocale('es');
    const hasSpecificTime = !(due.hour === 0 && due.minute === 0);

    if (!includeDate) {
      return hasSpecificTime ? `a las ${due.toFormat('HH:mm')}` : 'sin hora';
    }

    if (hasSpecificTime) {
      return `${this.formatDueLabel(dueDate, timezone)}`;
    }

    return due.toFormat('cccc dd/LL');
  }

  private formatDueLabel(dueDate: Date, timezone: string) {
    const due = DateTime.fromJSDate(dueDate).setZone(timezone).setLocale('es');
    const now = DateTime.now().setZone(timezone).setLocale('es');

    if (due.hasSame(now, 'day')) {
      return `hoy a las ${due.toFormat('HH:mm')}`;
    }

    if (due.hasSame(now.plus({ days: 1 }), 'day')) {
      return `mañana a las ${due.toFormat('HH:mm')}`;
    }

    return due.toFormat("'el' cccc dd/LL 'a las' HH:mm");
  }

  private formatTaskCreatedSummary(task: DisplayTask, timezone: string) {
    const scope =
      task.scope === TaskScope.FAMILY
        ? 'como tarea familiar 👪'
        : 'como tarea personal 👤';
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';
    const priority =
      task.priority === Priority.HIGH
        ? ' con prioridad alta ‼️'
        : task.priority === Priority.MEDIUM
          ? ' con prioridad media ⚠️'
          : '';
    return `"${task.title}" ${scope}, ${due}${priority}.`;
  }

  private formatScopeLabel(scope: TaskScope) {
    return scope === TaskScope.FAMILY ? '👪 Familiar' : '👤 Personal';
  }

  private formatScopeIcon(scope: TaskScope) {
    return scope === TaskScope.FAMILY ? '👪' : '👤';
  }

  private formatPriorityBadge(priority?: Priority) {
    if (priority === Priority.HIGH) {
      return '‼️';
    }

    if (priority === Priority.MEDIUM) {
      return '❕';
    }

    return '';
  }

  private formatPriorityLabel(priority: Priority) {
    if (priority === Priority.HIGH) {
      return 'Alta ‼️';
    }

    if (priority === Priority.MEDIUM) {
      return 'Media ❕';
    }

    return 'Baja';
  }

  private formatBulkSelectionPrompt(
    mode: 'COMPLETE' | 'DELETE',
    tasks: (DisplayTask & { id: string })[],
    selectedTaskIds: string[],
  ) {
    const actionLabel = mode === 'COMPLETE' ? 'completar' : 'eliminar';
    const selectedCount = selectedTaskIds.length;
    const lines = tasks.map((task, index) => {
      const marker = selectedTaskIds.includes(task.id) ? '✅' : '☐';
      return `${marker} ${index + 1}. ${this.truncateTaskTitle(task.title)}`;
    });

    return [
      `Selecciona las tareas que quieres ${actionLabel}.`,
      selectedCount > 0
        ? `Llevas ${selectedCount} seleccionada${selectedCount === 1 ? '' : 's'}.`
        : 'Aun no has seleccionado ninguna.',
      '',
      lines.join('\n'),
    ].join('\n');
  }

  private buildBulkSelectionKeyboard(
    mode: 'COMPLETE' | 'DELETE',
    tasks: (DisplayTask & { id: string })[],
    selectedTaskIds: string[],
  ) {
    const rows = tasks.map((task, index) => {
      const selected = selectedTaskIds.includes(task.id);
      const label = `${selected ? '✅' : '☐'} ${index + 1}. ${this.truncateTaskTitle(task.title, 18)}`;
      const callback = `bulk:toggle:${mode.toLowerCase()}:${index + 1}`;
      return [Markup.button.callback(label, callback)];
    });

    rows.push([
      Markup.button.callback(
        mode === 'COMPLETE' ? '✅ Confirmar' : '🗑️ Confirmar',
        mode === 'COMPLETE'
          ? CALLBACK_BULK_CONFIRM_COMPLETE
          : CALLBACK_BULK_CONFIRM_DELETE,
      ),
    ]);
    rows.push([Markup.button.callback(MENU_CANCEL, CALLBACK_BULK_CANCEL)]);

    return Markup.inlineKeyboard(rows);
  }

  private truncateTaskTitle(title: string, maxLength = 28) {
    if (title.length <= maxLength) {
      return title;
    }

    return `${title.slice(0, maxLength - 1)}…`;
  }

  private async getDefaultReplyMarkup(ctx: BotReplyContext) {
    const user = await this.usersService.findByTelegramUserId(
      String(ctx.from.id),
    );
    if (!user) {
      return undefined;
    }

    return this.mainMenuKeyboard;
  }

  private get mainMenuKeyboard() {
    return Markup.keyboard([
      [MENU_NEW_TASK, MENU_PENDING],
      [MENU_TODAY, MENU_FAMILY],
      [MENU_COMPLETED, MENU_HELP],
    ]).resize();
  }

  private get wizardScopeInlineKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          WIZARD_SCOPE_PERSONAL,
          CALLBACK_WIZARD_SCOPE_PERSONAL,
        ),
        Markup.button.callback(
          WIZARD_SCOPE_FAMILY,
          CALLBACK_WIZARD_SCOPE_FAMILY,
        ),
      ],
      [Markup.button.callback(MENU_CANCEL, CALLBACK_WIZARD_CANCEL)],
    ]);
  }

  private get wizardDueDateInlineKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback(WIZARD_DUE_NONE, CALLBACK_WIZARD_DUE_NONE)],
      [Markup.button.callback(MENU_CANCEL, CALLBACK_WIZARD_CANCEL)],
    ]);
  }

  private get wizardPriorityInlineKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          WIZARD_PRIORITY_HIGH,
          CALLBACK_WIZARD_PRIORITY_HIGH,
        ),
        Markup.button.callback(
          WIZARD_PRIORITY_MEDIUM,
          CALLBACK_WIZARD_PRIORITY_MEDIUM,
        ),
        Markup.button.callback(
          WIZARD_PRIORITY_LOW,
          CALLBACK_WIZARD_PRIORITY_LOW,
        ),
      ],
      [Markup.button.callback(MENU_CANCEL, CALLBACK_WIZARD_CANCEL)],
    ]);
  }

  private get wizardConfirmInlineKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback(WIZARD_CONFIRM_CREATE, CALLBACK_WIZARD_CONFIRM)],
      [Markup.button.callback(MENU_CANCEL, CALLBACK_WIZARD_CANCEL)],
    ]);
  }

  private async syncBotCommands() {
    if (!this.bot) {
      return;
    }

    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Iniciar o vincular tu cuenta' },
      { command: 'nueva', description: 'Crear una tarea guiada' },
      { command: 'pendientes', description: 'Ver tareas pendientes' },
      { command: 'hoy', description: 'Ver tareas de hoy' },
      { command: 'familiares', description: 'Ver tareas familiares' },
      { command: 'listas', description: 'Ver tareas completadas' },
      { command: 'ayuda', description: 'Ver ayuda y ejemplos' },
    ]);
  }

  private get helpMessage() {
    return [
      'Comandos disponibles:',
      '/start',
      '/ayuda',
      '/nueva',
      '/crearusuario Nombre +56912345678',
      '/hoy',
      '/pendientes',
      '/listas',
      '/familiares',
      '/hecho 2',
      '/eliminar 2',
      '',
      'Tambien puedes usar el menu persistente para crear y listar tareas.',
      '',
      'Nomenclatura:',
      '👪 Familiar: tarea compartida o visible para la familia.',
      '👤 Personal: tarea individual.',
      '‼️ Alta: prioridad importante.',
      '❕ Media: prioridad normal.',
      'Baja: sin icono especial.',
      '',
      'Tambien puedes escribir mensajes como:',
      'Comprar pan manana',
      'Tarea familiar: pagar cuentas',
    ].join('\n');
  }
}
