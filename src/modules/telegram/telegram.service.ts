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

  private async startTaskWizard(ctx: BotReplyContext) {
    await this.requireRegisteredUser(ctx);
    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'CREATE_TASK_WIZARD',
      step: 'TITLE',
      draft: {},
    });

    return 'Nueva tarea. Escribe el titulo.\n\nEjemplo: Comprar remedios para mi mama.\n\nPuedes responder "Cancelar" en cualquier paso.';
  }

  private async handleListToday(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listTodayTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList(
      'Tareas para hoy',
      tasks,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleListPending(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listPendingTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList(
      'Tareas pendientes',
      tasks,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleListFamily(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listFamilyTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList(
      'Tareas familiares',
      tasks,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleListCompleted(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listCompletedTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList(
      'Tareas completadas',
      tasks,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleComplete(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const index = Number(ctx.message.text.replace('/hecho', '').trim());
    const task = await this.tasksService.completeTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return `Tarea completada: ${task.title}`;
  }

  private async handleDelete(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const index = Number(ctx.message.text.replace('/eliminar', '').trim());
    const task = await this.tasksService.cancelTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return `Tarea cancelada: ${task.title}`;
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
        return `Tarea ${interpretation.taskIndex} completada.`;
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
        return `Tarea ${interpretation.taskIndex} cancelada.`;
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

  private formatTaskList(
    title: string,
    tasks: {
      title: string;
      dueDate: Date | null;
      scope: TaskScope;
      priority?: Priority;
    }[],
    timezone = this.configService.get<string>(
      'DEFAULT_TIMEZONE',
      'America/Santiago',
    ),
  ) {
    if (tasks.length === 0) {
      return `${title}\n\nNo hay tareas.`;
    }

    const lines = tasks.map((task, index) => {
      const due = task.dueDate
        ? ` - vence ${DateTime.fromJSDate(task.dueDate).setZone(timezone).toFormat('yyyy-LL-dd HH:mm')}`
        : '';
      const scope = task.scope === TaskScope.FAMILY ? ' [FAMILIAR]' : '';
      const priorityEmoji = task.priority === Priority.HIGH ? ' 🔴' : '';
      const priority =
        task.priority && task.priority !== Priority.MEDIUM
          ? ` [${task.priority}]`
          : '';
      return `${index + 1}. ${task.title}${scope}${priority}${priorityEmoji}${due}`;
    });

    return `${title}\n\n${lines.join('\n')}`;
  }

  private async safeReply(ctx: BotReplyContext, handler: Promise<string>) {
    try {
      const reply = await handler;
      const extra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(reply, extra);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      const extra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(message, extra);
    }
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
      return 'Operacion cancelada.';
    }

    const task = await this.tasksService.createTaskForUser(
      userId,
      pendingAction.dto,
    );

    if (pendingAction.reason === 'AMBIGUOUS_DATE') {
      return `Tarea creada sin fecha: ${task.title}`;
    }

    return `Tarea duplicada creada: ${task.title}`;
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

  private async tryHandleTaskWizard(ctx: BotTextContext, userId: string) {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'CREATE_TASK_WIZARD') {
      return null;
    }

    const text = ctx.message.text.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Creacion de tarea cancelada.';
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
        return '¿La tarea es personal o familiar?';
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
        return '¿Para cuando es? Escribe una fecha natural como "manana 18:00", "el viernes en la tarde" o responde "Sin fecha".';
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
        return '¿Que prioridad tiene? Responde "Alta", "Media" o "Baja".';
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
        return this.formatTaskDraftSummary(draft);
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
      return `No pude determinar una fecha exacta para "${dto.title}". ¿Quieres crearla sin fecha? Responde si o no.`;
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
      return `Ya existe una tarea pendiente muy parecida: "${duplicateTask.title}". ¿Quieres crear otra igual? Responde si o no.`;
    }

    const task = await this.tasksService.createTaskForUser(userId, dto);
    return `Tarea creada: ${task.title}`;
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
    const scope = draft.scope === TaskScope.FAMILY ? 'Familiar' : 'Personal';
    const priority =
      draft.priority === Priority.HIGH
        ? 'Alta'
        : draft.priority === Priority.LOW
          ? 'Baja'
          : 'Media';

    return [
      'Resumen de la tarea',
      `Titulo: ${draft.title ?? '-'}`,
      `Tipo: ${scope}`,
      `Vence: ${dueDate}`,
      `Prioridad: ${priority}`,
    ].join('\n');
  }

  private async getDefaultReplyMarkup(ctx: BotReplyContext) {
    const user = await this.usersService.findByTelegramUserId(
      String(ctx.from.id),
    );
    if (!user) {
      return undefined;
    }

    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (pendingAction?.type === 'CREATE_TASK_WIZARD') {
      switch (pendingAction.step) {
        case 'SCOPE':
          return this.wizardScopeKeyboard;
        case 'DUE_DATE':
          return this.wizardDueDateKeyboard;
        case 'PRIORITY':
          return this.wizardPriorityKeyboard;
        case 'CONFIRM':
          return this.wizardConfirmKeyboard;
        default:
          break;
      }
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

  private get wizardScopeKeyboard() {
    return Markup.keyboard([
      [WIZARD_SCOPE_PERSONAL, WIZARD_SCOPE_FAMILY],
      [MENU_CANCEL],
    ])
      .oneTime()
      .resize();
  }

  private get wizardDueDateKeyboard() {
    return Markup.keyboard([[WIZARD_DUE_NONE], [MENU_CANCEL]])
      .oneTime()
      .resize();
  }

  private get wizardPriorityKeyboard() {
    return Markup.keyboard([
      [WIZARD_PRIORITY_HIGH, WIZARD_PRIORITY_MEDIUM, WIZARD_PRIORITY_LOW],
      [MENU_CANCEL],
    ])
      .oneTime()
      .resize();
  }

  private get wizardConfirmKeyboard() {
    return Markup.keyboard([[WIZARD_CONFIRM_CREATE], [MENU_CANCEL]])
      .oneTime()
      .resize();
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
      'Tambien puedes escribir mensajes como:',
      'Comprar pan manana',
      'Tarea familiar: pagar cuentas',
    ].join('\n');
  }
}
