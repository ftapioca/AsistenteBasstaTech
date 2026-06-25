import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Priority, TaskScope, TaskStatus, UserRole } from '@prisma/client';
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
  description?: string | null;
  status?: TaskStatus;
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
const MENU_NEW_TASK = '📝 Nueva tarea';
const MENU_PENDING = '📋 Pendientes';
const MENU_EDIT_FAMILY = '👨‍👩‍👧 Editar familia';
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
const CALLBACK_EDIT_START = 'edit:start';
const CALLBACK_EDIT_CANCEL = 'edit:cancel';
const CALLBACK_BULK_START_DELETE = 'bulk:start:delete';
const CALLBACK_BULK_CANCEL = 'bulk:cancel';
const CALLBACK_BULK_CONFIRM_COMPLETE = 'bulk:confirm:complete';
const CALLBACK_BULK_CONFIRM_DELETE = 'bulk:confirm:delete';
const CALLBACK_FAMILY_CANCEL = 'family:cancel';
const CALLBACK_FAMILY_ADD_MEMBER = 'family:add_member';

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

    this.bot.command('completadas', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleListCompleted(typedCtx));
    });

    this.bot.command('familiares', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleListFamily(typedCtx));
    });

    this.bot.command('ver', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleViewTask(typedCtx));
    });

    this.bot.command('nota', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleTaskNote(typedCtx));
    });

    this.bot.command('editar', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleEdit(typedCtx));
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

    this.bot.action(/^edit:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleEditCallback(typedCtx);
    });

    this.bot.action(/^family:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleFamilyCallback(typedCtx);
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
    const addMemberReply = await this.tryHandleAddMemberContact(ctx);
    if (addMemberReply) {
      return addMemberReply;
    }

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
    const index = this.parseCommandIndex(
      ctx.message.text,
      '/hecho',
      'Usa /hecho N. Ejemplo: /hecho 2',
    );
    const task = await this.tasksService.completeTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return `Listo. Marque "${task.title}" como completada.`;
  }

  private async handleDelete(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const index = this.parseCommandIndex(
      ctx.message.text,
      '/eliminar',
      'Usa /eliminar N. Ejemplo: /eliminar 2',
    );
    const task = await this.tasksService.cancelTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return `Elimine "${task.title}" de tu lista.`;
  }

  private async handleEdit(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const raw = ctx.message.text.replace('/editar', '').trim();
    if (!raw) {
      const tasks = await this.tasksService.listPendingTasks(user.id);
      await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'EDIT_TASK_SELECTION',
      });

      return {
        text: this.formatEditSelectionPrompt(
          tasks,
          this.usersService.resolveTimezone(user),
        ),
        extra: this.buildEditSelectionKeyboard(tasks),
      };
    }

    const index = this.parseCommandIndex(
      ctx.message.text,
      '/editar',
      'Usa /editar N. Ejemplo: /editar 2',
    );
    const task = await this.tasksService.getEditableTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return {
      text: this.formatEditTaskMenu(
        task,
        this.usersService.resolveTimezone(user),
      ),
      extra: this.buildEditTaskKeyboard(task),
    };
  }

  private async handleViewTask(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const index = this.parseCommandIndex(
      ctx.message.text,
      '/ver',
      'Usa /ver N. Ejemplo: /ver 2',
    );
    const task = await this.tasksService.getVisibleTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    return this.formatTaskDetail(task, this.usersService.resolveTimezone(user));
  }

  private async handleTaskNote(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const raw = ctx.message.text.replace('/nota', '').trim();
    const match = raw.match(/^(\d+)(?:\s+([\s\S]+))?$/);

    if (!match) {
      throw new BadRequestException(
        'Formato invalido. Usa /nota N o /nota N texto.',
      );
    }

    const index = Number(match[1]);
    const inlineNote = match[2]?.trim();
    const task = await this.tasksService.getEditableTaskByIndex(
      user.id,
      String(ctx.chat.id),
      index,
    );

    if (inlineNote) {
      const description = /^(borrar|eliminar|quitar)$/i.test(inlineNote)
        ? null
        : inlineNote;
      const updatedTask = await this.tasksService.updateTaskDescription(
        user.id,
        task.id,
        description,
      );
      return description
        ? `Listo. Actualice la nota de "${updatedTask.title}".`
        : `Listo. Quite la nota de "${updatedTask.title}".`;
    }

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'EDIT_TASK_INPUT',
      field: 'NOTE',
      taskId: task.id,
    });

    return {
      text: [
        `Editar nota de "${task.title}"`,
        '',
        task.description?.trim()
          ? `Nota actual:\n${task.description}`
          : 'Actualmente no tiene nota.',
        '',
        'Escribe la nueva nota. Puede tener varias lineas.',
        'Si quieres borrar la nota, usa el boton correspondiente o responde "Borrar".',
        'Si prefieres salir, responde "Cancelar".',
      ].join('\n'),
      extra: this.buildEditNoteKeyboard(task),
    };
  }

  private async handleFamilyManagement(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    if (user.role !== UserRole.FAMILY_ADMIN) {
      return [
        'Gestion de familia',
        '',
        'Solo el administrador familiar puede agregar o quitar integrantes.',
        'Si necesitas cambios, pide ayuda a la persona que creo la familia.',
      ].join('\n');
    }

    const members = await this.usersService.listManagedUsers(user.id);
    return [
      {
        text: this.formatFamilyManagementText(user.family.name, members),
        extra: this.buildFamilyManagementKeyboard(members),
      },
    ][0];
  }

  private async handleNaturalLanguage(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const menuActionReply = await this.tryHandleMenuAction(ctx);
    if (menuActionReply) {
      return menuActionReply;
    }

    const addMemberReply = await this.tryHandleAddMemberWizardText(ctx);
    if (addMemberReply) {
      return addMemberReply;
    }

    const wizardReply = await this.tryHandleTaskWizard(ctx, user.id);
    if (wizardReply) {
      return wizardReply;
    }

    const editSelectionReply = await this.tryHandleEditTaskSelection(ctx, user.id);
    if (editSelectionReply) {
      return editSelectionReply;
    }

    const editReply = await this.tryHandleEditTaskInput(ctx, user.id);
    if (editReply) {
      return editReply;
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

    if (tasks.length > 0) {
      buttons.push(
        Markup.button.callback('✏️ Editar', CALLBACK_EDIT_START),
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
    const overdue: string[] = [];
    const today: string[] = [];
    const others: string[] = [];

    tasks.forEach((task, index) => {
      const line = `${index + 1}. ${this.formatTaskLine(task, timezone, false)}`;
      if (this.isTaskOverdue(task, timezone)) {
        overdue.push(line);
        return;
      }

      if (!task.dueDate) {
        others.push(line);
        return;
      }

      const due = DateTime.fromJSDate(task.dueDate).setZone(timezone);
      if (due.hasSame(now, 'day')) {
        today.push(line);
        return;
      }

      others.push(line);
    });

    const sections = [headings[listType]];
    if (overdue.length > 0) {
      sections.push(`🚨 Tareas vencidas\n${overdue.join('\n')}`);
    }
    if (today.length > 0) {
      sections.push(`🗓️ Hoy\n${today.join('\n')}`);
    }
    if (others.length > 0) {
      sections.push(`Otras tareas\n${others.join('\n')}`);
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
      case MENU_PENDING:
        return this.handleListPending(ctx);
      case MENU_EDIT_FAMILY:
        return this.handleFamilyManagement(ctx);
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

  private async safeHandleEditCallback(
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

      const result = await this.handleEditCallback(
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

  private async safeHandleFamilyCallback(
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

      const result = await this.handleFamilyCallback(
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

  private async handleEditCallback(
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

    if (data === CALLBACK_EDIT_START) {
      return this.startEditTaskSelection(ctx, user.id);
    }

    if (data === CALLBACK_EDIT_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cancelado',
        clearMarkup: true,
        reply: 'Listo, cancele la edicion de la tarea.',
      };
    }

    if (data === 'edit:back:list') {
      return this.startEditTaskSelection(ctx, user.id);
    }

    if (data.startsWith('edit:select:')) {
      const index = Number(data.replace('edit:select:', ''));
      const task = await this.tasksService.getEditableTaskByIndex(
        user.id,
        String(ctx.chat.id),
        index,
      );

      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Tarea seleccionada',
        editText: this.formatEditTaskMenu(
          task,
          this.usersService.resolveTimezone(user),
        ),
        editExtra: this.buildEditTaskKeyboard(task),
      };
    }

    if (data.startsWith('edit:menu:')) {
      const taskId = data.replace('edit:menu:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Editar tarea',
        editText: this.formatEditTaskMenu(
          task,
          this.usersService.resolveTimezone(user),
        ),
        editExtra: this.buildEditTaskKeyboard(task),
      };
    }

    if (data.startsWith('edit:field:title:')) {
      const taskId = data.replace('edit:field:title:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'EDIT_TASK_INPUT',
        field: 'TITLE',
        taskId: task.id,
      });

      return {
        answerText: 'Editar titulo',
        editText: [
          `Editar titulo de "${task.title}"`,
          '',
          'Escribe el nuevo titulo.',
          'Si prefieres salir, responde "Cancelar".',
        ].join('\n'),
        editExtra: this.buildEditInputKeyboard(task.id),
      };
    }

    if (data.startsWith('edit:field:due:')) {
      const taskId = data.replace('edit:field:due:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      return {
        answerText: 'Editar fecha',
        editText: [
          `Editar fecha/hora de "${task.title}"`,
          '',
          'Elige una opcion rapida o toca "Otro..." para escribir una fecha/hora personalizada.',
        ].join('\n'),
        editExtra: this.buildEditDueDateKeyboard(task.id),
      };
    }

    if (data.startsWith('edit:due:quick:')) {
      const [, , , taskId, option] = data.split(':');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      const dueDate = this.resolveQuickDueDateOption(
        option,
        task,
        this.usersService.resolveTimezone(user),
      );
      const updatedTask = await this.tasksService.updateTaskDueDate(
        user.id,
        taskId,
        dueDate,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        answerText: 'Fecha actualizada',
        editText: this.formatEditTaskMenu(
          updatedTask,
          this.usersService.resolveTimezone(user),
        ),
        editExtra: this.buildEditTaskKeyboard(updatedTask),
      };
    }

    if (data.startsWith('edit:due:custom:')) {
      const taskId = data.replace('edit:due:custom:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'EDIT_TASK_INPUT',
        field: 'DUE_DATE',
        taskId: task.id,
      });

      return {
        answerText: 'Fecha personalizada',
        editText: [
          `Editar fecha/hora de "${task.title}"`,
          '',
          'Escribe la nueva fecha y hora, por ejemplo "mañana 18:00".',
          'Si prefieres salir, responde "Cancelar".',
        ].join('\n'),
        editExtra: this.buildEditDueDateKeyboard(task.id),
      };
    }

    if (data.startsWith('edit:field:note:')) {
      const taskId = data.replace('edit:field:note:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'EDIT_TASK_INPUT',
        field: 'NOTE',
        taskId: task.id,
      });

      return {
        answerText: 'Editar nota',
        editText: [
          `Editar nota de "${task.title}"`,
          '',
          task.description?.trim()
            ? `Nota actual:\n${task.description}`
            : 'Actualmente no tiene nota.',
          '',
          'Escribe la nueva nota. Puede tener varias lineas.',
          'Si prefieres salir, responde "Cancelar".',
        ].join('\n'),
        editExtra: this.buildEditNoteKeyboard(task),
      };
    }

    if (data.startsWith('edit:due:clear:')) {
      const taskId = data.replace('edit:due:clear:', '');
      const task = await this.tasksService.updateTaskDueDate(
        user.id,
        taskId,
        null,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        answerText: 'Sin fecha',
        editText: this.formatEditTaskMenu(
          task,
          this.usersService.resolveTimezone(user),
        ),
        editExtra: this.buildEditTaskKeyboard(task),
      };
    }

    if (data.startsWith('edit:note:clear:')) {
      const taskId = data.replace('edit:note:clear:', '');
      const task = await this.tasksService.updateTaskDescription(
        user.id,
        taskId,
        null,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        answerText: 'Nota borrada',
        editText: this.formatEditTaskMenu(
          task,
          this.usersService.resolveTimezone(user),
        ),
        editExtra: this.buildEditTaskKeyboard(task),
      };
    }

    return {
      answerText: undefined,
      clearMarkup: false,
    };
  }

  private async handleFamilyCallback(
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

    if (user.role !== UserRole.FAMILY_ADMIN) {
      throw new BadRequestException(
        'Solo el administrador familiar puede gestionar miembros.',
      );
    }

    if (data === CALLBACK_FAMILY_CANCEL) {
      const members = await this.usersService.listManagedUsers(user.id);
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cancelado',
        editText: this.formatFamilyManagementText(user.family.name, members),
        editExtra: this.buildFamilyManagementKeyboard(members),
      };
    }

    if (data === CALLBACK_FAMILY_ADD_MEMBER) {
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'ADD_MEMBER_WIZARD',
        step: 'NAME',
        draft: {},
      });
      return {
        answerText: 'Agregar miembro',
        clearMarkup: true,
        reply: [
          'Vamos a agregar un miembro.',
          '',
          'Primero, escribe el nombre con el que quieres guardarlo.',
          'Despues te pedire que compartas su contacto.',
        ].join('\n'),
      };
    }

    if (data.startsWith('family:remove:')) {
      const targetUserId = data.replace('family:remove:', '');
      const members = await this.usersService.listManagedUsers(user.id);
      const target = members.find((member) => member.id === targetUserId);
      if (!target) {
        throw new BadRequestException(
          'Ese usuario ya no esta disponible para quitar.',
        );
      }

      return {
        answerText: 'Confirmar',
        editText: [
          'Quitar miembro',
          '',
          `Vas a quitar a ${target.name} de ${user.family.name}.`,
          'Perdera acceso al bot, pero su historial quedara guardado.',
          '',
          '¿Quieres continuar?',
        ].join('\n'),
        editExtra: this.buildFamilyRemovalConfirmationKeyboard(target.id),
      };
    }

    if (data.startsWith('family:confirm_remove:')) {
      const targetUserId = data.replace('family:confirm_remove:', '');
      const removedUser = await this.usersService.deactivateManagedUser(
        user.id,
        targetUserId,
      );
      const members = await this.usersService.listManagedUsers(user.id);
      return {
        answerText: 'Usuario quitado',
        editText: this.formatFamilyManagementText(user.family.name, members),
        editExtra: this.buildFamilyManagementKeyboard(members),
        reply: `Listo. Quite a ${removedUser.name} de la familia.`,
      };
    }

    return {
      answerText: undefined,
      clearMarkup: false,
    };
  }

  private async tryHandleAddMemberWizardText(
    ctx: BotTextContext,
  ): Promise<BotResponse | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'ADD_MEMBER_WIZARD') {
      return null;
    }

    const text = ctx.message.text.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, cancele la carga del nuevo miembro.';
    }

    if (pendingAction.step === 'NAME') {
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'ADD_MEMBER_WIZARD',
        step: 'CONTACT',
        draft: {
          name: text,
        },
      });

      return [
        `Perfecto. Guardare a la persona como "${text}".`,
        '',
        'Ahora comparte su contacto desde Telegram para tomar el numero.',
        'Si prefieres salir, responde "Cancelar".',
      ].join('\n');
    }

    return 'Estoy esperando que compartas el contacto de esa persona.';
  }

  private async tryHandleAddMemberContact(
    ctx: BotContactContext,
  ): Promise<string | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'ADD_MEMBER_WIZARD') {
      return null;
    }

    if (pendingAction.step !== 'CONTACT' || !pendingAction.draft.name) {
      return null;
    }

    const admin = await this.requireRegisteredUser(ctx);
    const createdUser = await this.usersService.createManagedUser(
      admin.id,
      validateDto(CreateUserDto, {
        name: pendingAction.draft.name,
        phoneNumber: ctx.message.contact.phone_number,
      }),
    );

    await this.tasksService.clearPendingAction(String(ctx.chat.id));
    return `Listo. Agregue a ${createdUser.name} a la familia. Esa persona ya puede escribir /start y vincular su cuenta.`;
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

  private async startEditTaskSelection(
    ctx: BotReplyContext,
    userId: string,
  ): Promise<BulkCallbackResult> {
    let tasks = await this.tasksService.getTasksFromContext(String(ctx.chat.id));
    if (tasks.length === 0) {
      tasks = await this.tasksService.listPendingTasks(userId);
      await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    }

    if (tasks.length === 0) {
      throw new BadRequestException(
        'No hay una lista reciente con tareas para editar.',
      );
    }

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'EDIT_TASK_SELECTION',
    });

    return {
      answerText: 'Editar tarea',
      editText: this.formatEditSelectionPrompt(
        tasks,
        this.usersService.resolveTimezone(
          await this.usersService.requireActiveUser(userId),
        ),
      ),
      editExtra: this.buildEditSelectionKeyboard(tasks),
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

  private async tryHandleEditTaskInput(
    ctx: BotTextContext,
    userId: string,
  ): Promise<BotResponse | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'EDIT_TASK_INPUT') {
      return null;
    }

    const text = ctx.message.text.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, cancele la edicion de la tarea.';
    }

    if (pendingAction.field === 'TITLE') {
      if (!text) {
        throw new BadRequestException('Escribe un titulo valido.');
      }

      const updatedTask = await this.tasksService.updateTaskTitle(
        userId,
        pendingAction.taskId,
        text,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        text: [
          'Listo. Actualice el titulo de la tarea.',
          '',
          this.formatEditTaskMenu(
            updatedTask,
            this.usersService.resolveTimezone(
              await this.usersService.requireActiveUser(userId),
            ),
          ),
        ].join('\n'),
        extra: this.buildEditTaskKeyboard(updatedTask),
      };
    }

    if (pendingAction.field === 'DUE_DATE') {
      const dueDate = await this.resolveWizardDueDate(text, userId);
      const updatedTask = await this.tasksService.updateTaskDueDate(
        userId,
        pendingAction.taskId,
        dueDate,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        text: [
          'Listo. Actualice la fecha/hora de la tarea.',
          '',
          this.formatEditTaskMenu(
            updatedTask,
            this.usersService.resolveTimezone(
              await this.usersService.requireActiveUser(userId),
            ),
          ),
        ].join('\n'),
        extra: this.buildEditTaskKeyboard(updatedTask),
      };
    }

    const description =
      lowered === 'borrar' || lowered === 'eliminar' || lowered === 'quitar'
        ? null
        : ctx.message.text.trim();
    const updatedTask = await this.tasksService.updateTaskDescription(
      userId,
      pendingAction.taskId,
      description,
    );
    await this.tasksService.clearPendingAction(String(ctx.chat.id));

    return {
      text: [
        description
          ? 'Listo. Actualice la nota de la tarea.'
          : 'Listo. Quite la nota de la tarea.',
        '',
        this.formatEditTaskMenu(
          updatedTask,
          this.usersService.resolveTimezone(
            await this.usersService.requireActiveUser(userId),
          ),
        ),
      ].join('\n'),
      extra: this.buildEditTaskKeyboard(updatedTask),
    };
  }

  private async tryHandleEditTaskSelection(
    ctx: BotTextContext,
    userId: string,
  ): Promise<BotResponse | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'EDIT_TASK_SELECTION') {
      return null;
    }

    const text = ctx.message.text.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, cancele la edicion de la tarea.';
    }

    const index = Number(text);
    if (!Number.isInteger(index) || index <= 0) {
      throw new BadRequestException(
        'Responde solo con el numero de la tarea que quieres editar. Ejemplo: 2',
      );
    }

    const task = await this.tasksService.getEditableTaskByIndex(
      userId,
      String(ctx.chat.id),
      index,
    );

    return {
      text: this.formatEditTaskMenu(
        task,
        this.usersService.resolveTimezone(
          await this.usersService.requireActiveUser(userId),
        ),
      ),
      extra: this.buildEditTaskKeyboard(task),
    };
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
    const noteBadge = task.description?.trim() ? '📝' : '';
    const overdueBadge = this.isTaskOverdue(task, timezone) ? '🚨' : '';

    return `${overdueBadge ? `${overdueBadge} ` : ''}${badges}${noteBadge ? ` ${noteBadge}` : ''} ${task.title} · ${due}`.trim();
  }

  private formatTaskDueText(
    dueDate: Date,
    timezone: string,
    includeDate: boolean,
  ) {
    const due = DateTime.fromJSDate(dueDate).setZone(timezone).setLocale('es');
    const hasSpecificTime = !(due.hour === 0 && due.minute === 0);
    const isOverdue = due < DateTime.now().setZone(timezone);

    if (!includeDate) {
      if (isOverdue) {
        const minutesOverdue = Math.max(
          1,
          Math.round(DateTime.now().setZone(timezone).diff(due, 'minutes').minutes),
        );
        if (minutesOverdue < 60) {
          return `vencido hace ${minutesOverdue} min`;
        }

        const hoursOverdue = Math.round((minutesOverdue / 60) * 10) / 10;
        return `vencido hace ${hoursOverdue} hora${hoursOverdue === 1 ? '' : 's'}`;
      }
      return hasSpecificTime ? `a las ${due.toFormat('HH:mm')}` : 'sin hora';
    }

    if (isOverdue) {
      return hasSpecificTime
        ? `vencida · ${due.toFormat('cccc dd/LL HH:mm')}`
        : `vencida · ${due.toFormat('cccc dd/LL')}`;
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
          ? ' con prioridad media ❕'
          : '';
    return `"${task.title}" ${scope}, ${due}${priority}.`;
  }

  private resolveQuickDueDateOption(
    option: string,
    task: DisplayTask,
    timezone: string,
  ) {
    const now = DateTime.now().setZone(timezone);

    if (option === 'plus30m') {
      return now.plus({ minutes: 30 }).toUTC().toISO();
    }

    if (option === 'plus2h') {
      return now.plus({ hours: 2 }).toUTC().toISO();
    }

    if (option === 'tomorrow') {
      const taskDue = task.dueDate
        ? DateTime.fromJSDate(task.dueDate).setZone(timezone)
        : null;
      const hasSpecificTime = taskDue
        ? !(taskDue.hour === 0 && taskDue.minute === 0)
        : false;
      const tomorrow = now.plus({ days: 1 }).startOf('day').set({
        hour: hasSpecificTime ? taskDue!.hour : 9,
        minute: hasSpecificTime ? taskDue!.minute : 0,
        second: 0,
        millisecond: 0,
      });
      return tomorrow.toUTC().toISO();
    }

    throw new BadRequestException('Opcion de fecha rapida no valida.');
  }

  private isTaskOverdue(task: DisplayTask, timezone: string) {
    if (!task.dueDate || task.status === TaskStatus.COMPLETED) {
      return false;
    }

    return DateTime.fromJSDate(task.dueDate).setZone(timezone) <
      DateTime.now().setZone(timezone);
  }

  private parseCommandIndex(
    text: string,
    command: string,
    invalidFormatMessage: string,
  ) {
    const raw = text.replace(command, '').trim();
    const index = Number(raw);

    if (!raw || !Number.isInteger(index) || index <= 0) {
      throw new BadRequestException(invalidFormatMessage);
    }

    return index;
  }

  private formatTaskDetail(
    task: DisplayTask & { description?: string | null },
    timezone: string,
  ) {
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';

    return [
      'Detalle de tarea',
      `Titulo: ${task.title}`,
      `Tipo: ${this.formatScopeLabel(task.scope)}`,
      `Vence: ${due}`,
      `Prioridad: ${this.formatPriorityLabel(task.priority ?? Priority.MEDIUM)}`,
      '',
      'Nota:',
      task.description?.trim() || 'Sin nota.',
    ].join('\n');
  }

  private formatFamilyManagementText(
    familyName: string,
    members: { id: string; name: string; phoneNumber: string }[],
  ) {
    const memberLines =
      members.length === 0
        ? ['No hay miembros gestionables por ahora.']
        : members.map(
            (member, index) =>
              `${index + 1}. ${member.name} · ${member.phoneNumber}`,
          );

    return [
      `Gestion de ${familyName}`,
      '',
      'Agregar miembros:',
      'Usa /crearusuario Nombre +56912345678',
      '',
      'Miembros actuales:',
      ...memberLines,
      '',
      'Debajo de este mensaje puedes quitar miembros.',
    ].join('\n');
  }

  private buildFamilyManagementKeyboard(
    members: { id: string; name: string }[],
  ) {
    const rows = [
      [
        Markup.button.callback(
          '🆕 Agregar miembro',
          CALLBACK_FAMILY_ADD_MEMBER,
        ),
      ],
      ...members.map((member) => [
        Markup.button.callback(
          `Quitar ${this.truncateTaskTitle(member.name, 20)}`,
          `family:remove:${member.id}`,
        ),
      ]),
    ];

    rows.push([Markup.button.callback('Cerrar', CALLBACK_FAMILY_CANCEL)]);

    return Markup.inlineKeyboard(rows);
  }

  private buildFamilyRemovalConfirmationKeyboard(userId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          'Quitar miembro',
          `family:confirm_remove:${userId}`,
        ),
      ],
      [Markup.button.callback('Cancelar', CALLBACK_FAMILY_CANCEL)],
    ]);
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
        mode === 'COMPLETE' ? '✅ Confirmar' : '🗑️ Eliminar',
        mode === 'COMPLETE'
          ? CALLBACK_BULK_CONFIRM_COMPLETE
          : CALLBACK_BULK_CONFIRM_DELETE,
      ),
    ]);
    rows.push([Markup.button.callback(MENU_CANCEL, CALLBACK_BULK_CANCEL)]);

    return Markup.inlineKeyboard(rows);
  }

  private formatEditSelectionPrompt(
    tasks: (DisplayTask & { id: string })[],
    timezone: string,
  ) {
    const lines = tasks.map(
      (task, index) => `${index + 1}. ${this.formatTaskLine(task, timezone, false)}`,
    );

    return [
      '¿Que tarea quieres editar?',
      '',
      lines.join('\n'),
      '',
      'Puedes tocar una opcion o responder solo con el numero.',
    ].join('\n');
  }

  private buildEditSelectionKeyboard(tasks: (DisplayTask & { id: string })[]) {
    const rows = tasks.map((task, index) => [
      Markup.button.callback(
        `${index + 1}. ${this.truncateTaskTitle(task.title, 18)}`,
        `edit:select:${index + 1}`,
      ),
    ]);

    rows.push([Markup.button.callback(MENU_CANCEL, CALLBACK_EDIT_CANCEL)]);
    return Markup.inlineKeyboard(rows);
  }

  private formatEditTaskMenu(
    task: DisplayTask & { id?: string; description?: string | null },
    timezone: string,
  ) {
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';

    return [
      'Editar tarea',
      `Titulo: ${task.title}`,
      `Vence: ${due}`,
      `Nota: ${task.description?.trim() ? 'Sí' : 'No'}`,
      '',
      '¿Que quieres cambiar?',
    ].join('\n');
  }

  private buildEditTaskKeyboard(
    task: DisplayTask & { id: string; description?: string | null },
  ) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✏️ Titulo',
          `edit:field:title:${task.id}`,
        ),
        Markup.button.callback(
          '🕒 Fecha/Hora',
          `edit:field:due:${task.id}`,
        ),
      ],
      [
        Markup.button.callback(
          task.description?.trim() ? '📝 Editar nota' : '📝 Agregar nota',
          `edit:field:note:${task.id}`,
        ),
      ],
      [
        Markup.button.callback('⬅️ Cambiar tarea', 'edit:back:list'),
        Markup.button.callback('Cerrar', CALLBACK_EDIT_CANCEL),
      ],
    ]);
  }

  private buildEditInputKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '⬅️ Volver',
          `edit:menu:${taskId}`,
        ),
        Markup.button.callback('Cancelar', CALLBACK_EDIT_CANCEL),
      ],
    ]);
  }

  private buildEditDueDateKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('+30 min', `edit:due:quick:${taskId}:plus30m`),
        Markup.button.callback('+2 horas', `edit:due:quick:${taskId}:plus2h`),
      ],
      [
        Markup.button.callback('Mañana', `edit:due:quick:${taskId}:tomorrow`),
        Markup.button.callback('Otro...', `edit:due:custom:${taskId}`),
      ],
      [Markup.button.callback('Sin fecha', `edit:due:clear:${taskId}`)],
      [
        Markup.button.callback(
          '⬅️ Volver',
          `edit:menu:${taskId}`,
        ),
        Markup.button.callback('Cancelar', CALLBACK_EDIT_CANCEL),
      ],
    ]);
  }

  private buildEditNoteKeyboard(
    task: DisplayTask & { id: string; description?: string | null },
  ) {
    const rows = [];
    if (task.description?.trim()) {
      rows.push([
        Markup.button.callback('🗑️ Borrar nota', `edit:note:clear:${task.id}`),
      ]);
    }

    rows.push([
      Markup.button.callback(
        '⬅️ Volver',
        `edit:menu:${task.id}`,
      ),
      Markup.button.callback('Cancelar', CALLBACK_EDIT_CANCEL),
    ]);

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
      [MENU_EDIT_FAMILY, MENU_HELP],
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
      { command: 'completadas', description: 'Ver tareas completadas' },
      { command: 'ver', description: 'Ver detalle de una tarea' },
      { command: 'nota', description: 'Agregar o editar nota de una tarea' },
      { command: 'editar', description: 'Editar vencimiento de una tarea' },
      { command: 'ayuda', description: 'Ver ayuda y ejemplos' },
    ]);
  }

  private get helpMessage() {
    return [
      'Que puedes hacer con este bot',
      '',
      '1. Crear tareas escribiendo en lenguaje natural.',
      'Ejemplos:',
      '- Comprar remedios mañana a las 18:00',
      '- Tarea familiar: pagar cuentas el viernes en la tarde',
      '',
      '2. Crear tareas guiadas con el boton "📝 Nueva tarea".',
      'El bot te pide titulo, tipo, fecha y prioridad paso a paso.',
      '',
      '3. Ver y ordenar pendientes.',
      'Las listas se agrupan por Hoy, Mañana, dias futuros y Sin fecha.',
      '',
      '4. Completar o eliminar varias tareas de una vez.',
      'Desde una lista reciente puedes usar los botones inline para seleccionar varias tareas.',
      '',
      '5. Ver detalle y nota de una tarea.',
      'Usa /ver N para abrir una tarea de la ultima lista mostrada.',
      '',
      '6. Agregar o editar notas.',
      'Usa /nota N para escribir una nota o pegar una lista larga en varias lineas.',
      '',
      '7. Editar el vencimiento de una tarea pendiente.',
      'Usa /editar N despues de /pendientes, /hoy o /familiares.',
      '',
      '8. Gestionar tu familia.',
      'El administrador puede agregar y quitar miembros desde el bot.',
      '',
      '',
      'Nomenclatura:',
      '👪 Familiar: tarea compartida o visible para la familia.',
      '👤 Personal: tarea individual.',
      '‼️ Alta: prioridad importante.',
      '❕ Media: prioridad normal.',
      'Baja: sin icono especial.',
      '',
      'Comandos disponibles:',
      '/start',
      '/ayuda',
      '/nueva',
      '/crearusuario Nombre +56912345678',
      '/hoy',
      '/pendientes',
      '/completadas',
      '/familiares',
      '/ver 2',
      '/nota 2',
      '/editar 2',
      '/hecho 2',
      '/eliminar 2',
    ].join('\n');
  }
}
