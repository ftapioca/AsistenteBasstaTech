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

type BotVoiceContext = BotReplyContext & {
  message: {
    voice: {
      file_id: string;
      mime_type?: string;
      duration: number;
      file_size?: number;
    };
  };
};

type DisplayTask = {
  id?: string;
  title: string;
  dueDate: Date | null;
  scope: TaskScope;
  priority?: Priority;
  description?: string | null;
  status?: TaskStatus;
  reminderMinutesBefore?: number | null;
  assignedToUserId?: string | null;
  assignedToUserName?: string | null;
  assignedToUser?: { id: string; name: string } | null;
  createdByUserId?: string;
  createdByUser?: { id: string; name: string } | null;
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
const MENU_PENDING = '📋 Ver tareas';
const MENU_EDIT_FAMILY = '👨‍👩‍👧 Editar familia';
const MENU_HELP = '❓ Ayuda';
const MENU_CANCEL = 'Cancelar';
const WIZARD_SCOPE_PERSONAL = 'Personal';
const WIZARD_SCOPE_FAMILY = 'Familiar';
const WIZARD_DUE_NONE = 'Sin fecha';
const WIZARD_PRIORITY_HIGH = 'Alta';
const WIZARD_PRIORITY_MEDIUM = 'Media';
const WIZARD_PRIORITY_LOW = 'Baja';
const WIZARD_ASSIGNEE_NONE = 'Sin asignar';
const WIZARD_NOTE_YES = 'Si, agregar nota';
const WIZARD_NOTE_NO = 'No, continuar';
const WIZARD_CONFIRM_CREATE = 'Crear tarea';
const CALLBACK_WIZARD_SCOPE_PERSONAL = 'wizard:scope:personal';
const CALLBACK_WIZARD_SCOPE_FAMILY = 'wizard:scope:family';
const CALLBACK_WIZARD_DUE_NONE = 'wizard:due:none';
const CALLBACK_WIZARD_CANCEL = 'wizard:cancel';
const CALLBACK_WIZARD_PRIORITY_HIGH = 'wizard:priority:high';
const CALLBACK_WIZARD_PRIORITY_MEDIUM = 'wizard:priority:medium';
const CALLBACK_WIZARD_PRIORITY_LOW = 'wizard:priority:low';
const CALLBACK_WIZARD_NOTE_YES = 'wizard:note:yes';
const CALLBACK_WIZARD_NOTE_NO = 'wizard:note:no';
const CALLBACK_WIZARD_CONFIRM = 'wizard:confirm';
const CALLBACK_BULK_START_COMPLETE = 'bulk:start:complete';
const CALLBACK_VIEW_START = 'view:start';
const CALLBACK_EDIT_START = 'edit:start';
const CALLBACK_EDIT_CANCEL = 'edit:cancel';
const CALLBACK_EDIT_SECTION_CONTENT = 'edit:section:content';
const CALLBACK_EDIT_SECTION_SCHEDULE = 'edit:section:schedule';
const CALLBACK_ALERTS_CANCEL = 'alerts:cancel';
const CALLBACK_ALERTS_HOME = 'alerts:home';
const CALLBACK_ALERTS_SECTION_REMINDERS = 'alerts:section:reminders';
const CALLBACK_ALERTS_SECTION_BRIEFING = 'alerts:section:briefing';
const CALLBACK_HELP_CANCEL = 'help:cancel';
const CALLBACK_BULK_START_DELETE = 'bulk:start:delete';
const CALLBACK_BULK_CANCEL = 'bulk:cancel';
const CALLBACK_BULK_CONFIRM_COMPLETE = 'bulk:confirm:complete';
const CALLBACK_BULK_CONFIRM_DELETE = 'bulk:confirm:delete';
const CALLBACK_FAMILY_CANCEL = 'family:cancel';
const CALLBACK_FAMILY_CLOSE = 'family:close';
const CALLBACK_FAMILY_VIEW_MEMBERS = 'family:view_members';
const CALLBACK_FAMILY_INVITE_MEMBER = 'family:invite_member';
const CALLBACK_FAMILY_ADD_MEMBER_MANUAL = 'family:add_member_manual';
const CALLBACK_FAMILY_SKIP_ONBOARDING = 'family:skip_onboarding';
const CALLBACK_FAMILY_RENAME = 'family:rename';
const CALLBACK_FAMILY_START_REMOVE = 'family:start_remove';
const CALLBACK_FAMILY_CONFIRM_REMOVE = 'family:confirm_remove';
const CALLBACK_FAMILY_START_TRANSFER = 'family:start_transfer';
const FAMILY_INVITE_START_PREFIX = 'join-family-';

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

    const allowPolling = this.configService.get<boolean>(
      'ALLOW_TELEGRAM_POLLING',
    );
    if (!allowPolling) {
      this.logger.warn(
        'Telegram deshabilitado: no hay webhook configurado y ALLOW_TELEGRAM_POLLING=false.',
      );
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

  async sendText(chatId: string, text: string, extra?: unknown) {
    if (!this.bot) {
      return;
    }

    await this.bot.telegram.sendMessage(
      chatId,
      text,
      extra as Parameters<typeof this.bot.telegram.sendMessage>[2],
    );
  }

  async sendTaskReminder(chatId: string, taskId: string, text: string) {
    await this.sendText(
      chatId,
      text,
      this.withHtml(
        Markup.inlineKeyboard([
          [Markup.button.callback('🔎 Ver detalle', `view:detail:${taskId}`)],
        ]),
      ),
    );
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
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(
        typedCtx,
        Promise.resolve(this.buildHelpHomeResponse()),
      );
    });

    this.bot.command('alertas', async (ctx) => {
      const typedCtx = ctx as unknown as BotTextContext;
      await this.safeReply(typedCtx, this.handleAlertsSettings(typedCtx));
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

    this.bot.on(message('voice'), async (ctx) => {
      const typedCtx = ctx as unknown as BotVoiceContext;
      await this.safeReply(typedCtx, this.handleVoiceMessage(typedCtx));
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

    this.bot.action(/^view:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleViewCallback(typedCtx);
    });

    this.bot.action(/^edit:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleEditCallback(typedCtx);
    });

    this.bot.action(/^alerts:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleAlertsCallback(typedCtx);
    });

    this.bot.action(/^help:/, async (ctx) => {
      const typedCtx = ctx as unknown as BotCallbackContext & {
        callbackQuery: { data?: string };
      };
      await this.safeHandleHelpCallback(typedCtx);
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
    const inviteReply = await this.tryHandleFamilyInviteStart(ctx);
    if (inviteReply) {
      return inviteReply;
    }

    const registeredUser = await this.usersService.findByTelegramUserId(
      String(ctx.from.id),
    );

    if (registeredUser) {
      await ctx.reply(
        `Hola ${registeredUser.name}. Ya estas vinculado a la familia ${registeredUser.family.name}.`,
        this.buildMainMenuKeyboard(registeredUser.role),
      );
      return this.buildHelpHomeResponse();
    }

    await ctx.reply(
      'Para vincularte o crear tu familia, comparte tu numero usando el boton de contacto.',
      Markup.keyboard([[Markup.button.contactRequest('Compartir mi contacto')]])
        .oneTime()
        .resize(),
    );

    return 'Quedo atento a tu contacto para continuar.';
  }

  private async tryHandleFamilyInviteStart(ctx: BotReplyContext) {
    const payload = this.getStartPayload(ctx);
    if (!payload?.startsWith(FAMILY_INVITE_START_PREFIX)) {
      return null;
    }

    const familyId = payload.replace(FAMILY_INVITE_START_PREFIX, '').trim();
    if (!familyId) {
      return null;
    }

    const linkedUser = await this.usersService.findByTelegramUserId(
      String(ctx.from.id),
    );
    if (linkedUser) {
      return `Ya estas vinculado a la familia ${linkedUser.family.name}.`;
    }

    const family = await this.usersService.findFamilyById(familyId);
    if (!family) {
      throw new BadRequestException('La invitacion ya no esta disponible.');
    }

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'JOIN_FAMILY_INVITE',
      familyId: family.id,
      familyName: family.name,
    });

    await ctx.reply(
      [
        this.bold(`Te invitaron a unirte a ${family.name}.`),
        '',
        this.bold('Comparte tu numero usando el boton de contacto.'),
      ].join('\n'),
      this.withHtml(
        Markup.keyboard([[Markup.button.contactRequest('Compartir mi contacto')]])
          .oneTime()
          .resize(),
      ),
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

    const linkInput = {
      phoneNumber: contact.phone_number,
      telegramUserId: String(ctx.from.id),
      telegramChatId: String(ctx.chat.id),
      telegramUsername: ctx.from.username,
      fallbackName: ctx.from.first_name || contact.first_name || 'Usuario',
    };
    const joinInviteReply = await this.tryHandleJoinFamilyInviteContact(
      ctx,
      linkInput,
    );
    if (joinInviteReply) {
      return joinInviteReply;
    }

    const existingUser = await this.usersService.findByPhoneNumberForLink(
      contact.phone_number,
    );

    if (!existingUser) {
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'CREATE_FAMILY_CONFIRMATION',
        step: 'FAMILY_NAME',
        ...linkInput,
      });

      return {
        text: [
          this.bold('No encontre una cuenta existente para ese numero.'),
          '',
          this.bold('Escribe el nombre que quieres para tu familia.'),
          this.bold('Si prefieres salir, responde "Cancelar".'),
        ].join('\n'),
        extra: this.withHtml(),
      };
    }

    const user = await this.usersService.linkExistingTelegramAccount(
      existingUser.id,
      linkInput,
    );

    await ctx.reply('Cuenta vinculada correctamente.', Markup.removeKeyboard());

    if (user.role === UserRole.FAMILY_ADMIN) {
      return this.buildFamilyCreatedResponse(user.name, user.family.name);
    }

    return `Bienvenido ${user.name}. Quedaste vinculado a la familia ${user.family.name}.`;
  }

  private async handleVoiceMessage(ctx: BotVoiceContext): Promise<BotResponse> {
    try {
      const audio = await this.downloadTelegramFile(ctx.message.voice.file_id);
      const transcription = await this.aiService.transcribeVoiceNote({
        audio,
        fileName: 'telegram-voice.ogg',
        mimeType: ctx.message.voice.mime_type ?? 'audio/ogg',
        language: 'es',
      });
      const textContext: BotTextContext = {
        from: ctx.from,
        chat: ctx.chat,
        reply: ctx.reply.bind(ctx),
        message: {
          text: transcription.text,
        },
      };
      const reply = await this.handleNaturalLanguage(textContext);

      if (!transcription.lowConfidence) {
        return reply;
      }

      return this.prependVoiceTranscript(reply, transcription.text);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.warn(
        `No se pudo procesar la nota de voz de ${ctx.from.id}: ${message}`,
      );
      return 'No pude entender ese audio. Intenta de nuevo o escríbelo.';
    }
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
      text: [
        this.bold('Vamos a crear una tarea.'),
        '',
        this.bold('Primero, escribe el titulo.'),
        'Ejemplo: Comprar remedios para mi mama.',
        '',
        this.bold('Puedes responder "Cancelar" en cualquier paso.'),
      ].join('\n'),
      extra: this.withHtml(),
    };
  }

  private async handleListToday(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listTodayTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse(
      'today',
      tasks,
      true,
      true,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleListPending(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listPendingTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse(
      'pending',
      tasks,
      true,
      true,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleListFamily(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listFamilyTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse(
      'family',
      tasks,
      true,
      true,
      this.usersService.resolveTimezone(user),
    );
  }

  private async handleListCompleted(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listCompletedTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.buildTaskListResponse(
      'completed',
      tasks,
      false,
      false,
      this.usersService.resolveTimezone(user),
    );
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
        extra: this.withHtml(this.buildEditSelectionKeyboard(tasks)),
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
        this.usersService.resolveReminderMinutesBefore(user),
      ),
      extra: this.withHtml(this.buildEditTaskKeyboard(task)),
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

    return {
      text: this.formatTaskDetail(
        task,
        this.usersService.resolveTimezone(user),
        this.usersService.resolveReminderMinutesBefore(user),
      ),
      extra: this.withHtml(),
    };
  }

  private async handleTaskNote(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const raw = ctx.message.text.replace('/nota', '').trim();
    const match = raw.match(/^(\d+)(?:\s+([\s\S]+))?$/);

    if (!match) {
      throw new BadRequestException(
        'Formato invalido. Usa /nota N o /nota N texto. La nota puede tener hasta 1500 caracteres.',
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
        this.bold(`Editar nota de "${task.title}"`),
        '',
        task.description?.trim()
          ? `${this.bold('Nota actual:')}\n${this.escapeHtml(task.description)}`
          : 'Actualmente no tiene nota.',
        '',
        this.bold(
          'Escribe la nueva nota. Puede tener varias lineas y hasta 1500 caracteres.',
        ),
        this.bold(
          'Si quieres borrar la nota, usa el boton correspondiente o responde "Borrar".',
        ),
        this.bold('Si prefieres salir, responde "Cancelar".'),
      ].join('\n'),
      extra: this.withHtml(this.buildEditNoteKeyboard(task)),
    };
  }

  private async handleAlertsSettings(
    ctx: BotTextContext,
  ): Promise<BotResponse> {
    const user = await this.requireRegisteredUser(ctx);
    return {
      text: this.formatAlertsHomeMenu(user),
      extra: this.withHtml(this.buildAlertsHomeKeyboard()),
    };
  }

  private async handleFamilyManagement(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    if (user.role !== UserRole.FAMILY_ADMIN) {
      return {
        text: [
          this.bold('Gestion de familia'),
          '',
          this.bold(
            'Solo el administrador familiar puede agregar o quitar integrantes.',
          ),
          this.bold(
            'Si necesitas cambios, pide ayuda a la persona que creo la familia.',
          ),
        ].join('\n'),
        extra: this.withHtml(this.buildMainMenuKeyboard(user.role)),
      };
    }

    return {
      text: this.formatFamilyManagementText(user.family.name),
      extra: this.withHtml(this.buildFamilyManagementKeyboard()),
    };
  }

  private async handleNaturalLanguage(ctx: BotTextContext) {
    const createFamilyReply = await this.tryHandleCreateFamilySetup(ctx);
    if (createFamilyReply) {
      return createFamilyReply;
    }

    const confirmationReply = await this.tryHandlePendingConfirmation(ctx);
    if (confirmationReply) {
      return confirmationReply;
    }

    const user = await this.requireRegisteredUser(ctx);
    const menuActionReply = await this.tryHandleMenuAction(ctx);
    if (menuActionReply) {
      return menuActionReply;
    }

    const addMemberReply = await this.tryHandleAddMemberWizardText(ctx);
    if (addMemberReply) {
      return addMemberReply;
    }

    const renameFamilyReply = await this.tryHandleRenameFamilyText(ctx);
    if (renameFamilyReply) {
      return renameFamilyReply;
    }

    const renameFamilyMemberReply = await this.tryHandleRenameFamilyMemberText(
      ctx,
    );
    if (renameFamilyMemberReply) {
      return renameFamilyMemberReply;
    }

    const wizardReply = await this.tryHandleTaskWizard(ctx, user.id);
    if (wizardReply) {
      return wizardReply;
    }

    const editSelectionReply = await this.tryHandleEditTaskSelection(
      ctx,
      user.id,
    );
    if (editSelectionReply) {
      return editSelectionReply;
    }

    const editReply = await this.tryHandleEditTaskInput(ctx, user.id);
    if (editReply) {
      return editReply;
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
        return this.buildHelpHomeResponse();
      case 'CREATE_TASK': {
        const scope = interpretation.scope ?? TaskScope.PERSONAL;
        const assignedToUserId = await this.resolveCreateTaskAssignee(
          user.id,
          scope,
          interpretation.assigneeName ?? null,
        );
        const dto = validateDto(CreateTaskDto, {
          title: interpretation.title ?? ctx.message.text,
          description: interpretation.description ?? null,
          scope,
          priority: interpretation.priority ?? Priority.MEDIUM,
          dueDate: this.normalizeDueDate(interpretation.dueDate),
          assignedToUserId,
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
            assignedToUserId: user.id,
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

  private async downloadTelegramFile(fileId: string) {
    if (!this.bot) {
      throw new Error('Telegram no esta inicializado.');
    }

    const fileUrl = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(
        `No se pudo descargar el archivo de Telegram (${response.status}).`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
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
    timezone = this.configService.get<string>(
      'DEFAULT_TIMEZONE',
      'America/Santiago',
    ),
  ): BotResponse {
    const text = this.formatTaskList(listType, tasks, timezone);
    const keyboard = this.buildTaskListKeyboard(
      tasks,
      allowBulkComplete,
      allowBulkDelete,
    );

    if (!keyboard) {
      return text;
    }

    return {
      text,
      extra: this.withHtml(keyboard),
    };
  }

  private buildTaskListKeyboard(
    tasks: DisplayTask[],
    allowBulkComplete: boolean,
    allowBulkDelete: boolean,
  ) {
    const buttons = [];

    if (tasks.length > 0) {
      buttons.push(Markup.button.callback('🔎 Ver tarea', CALLBACK_VIEW_START));
    }

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
      return null;
    }

    return Markup.inlineKeyboard([buttons]);
  }

  private async buildTaskCreatedResponse(
    chatId: string,
    userId: string,
    task: DisplayTask,
  ): Promise<BotResponse> {
    const user = await this.usersService.requireActiveUser(userId);
    const timezone = this.usersService.resolveTimezone(user);
    const todayTasks = await this.tasksService.listTodayTasks(userId);
    await this.tasksService.storeTaskListContext(chatId, todayTasks);
    const keyboard = this.buildTaskListKeyboard(todayTasks, true, true);

    return {
      text: [
        `${this.bold('Listo.')} Agregue ${this.formatTaskCreatedSummary(task, timezone)}`,
        '',
        this.formatTaskList('today', todayTasks, timezone),
      ].join('\n'),
      extra: this.withHtml(keyboard ?? undefined),
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
          `${this.bold(`${index + 1}.`)} ${this.formatTaskLine(task, timezone, false)}`,
      );
      return `${this.bold(headings[listType])}\n\n${lines.join('\n')}`;
    }

    const now = DateTime.now().setZone(timezone);
    const overdue: string[] = [];
    const today: string[] = [];
    const others: string[] = [];

    tasks.forEach((task, index) => {
      const lineForToday = `${this.bold(`${index + 1}.`)} ${this.formatTaskLine(task, timezone, false)}`;
      const lineForOtherDate = `${this.bold(`${index + 1}.`)} ${this.formatTaskLine(task, timezone, true)}`;
      if (this.isTaskOverdue(task, timezone)) {
        overdue.push(lineForToday);
        return;
      }

      if (!task.dueDate) {
        others.push(lineForOtherDate);
        return;
      }

      const due = DateTime.fromJSDate(task.dueDate).setZone(timezone);
      if (due.hasSame(now, 'day')) {
        today.push(lineForToday);
        return;
      }

      others.push(lineForOtherDate);
    });

    const sections = [this.bold(headings[listType])];
    if (overdue.length > 0) {
      sections.push(
        `${this.bold('🚨 Tareas vencidas')}\n${overdue.join('\n')}`,
      );
    }
    if (today.length > 0) {
      sections.push(`${this.bold('🗓️ Hoy')}\n${today.join('\n')}`);
    }
    if (others.length > 0) {
      sections.push(`${this.bold('Otras tareas')}\n${others.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  private async safeReply(ctx: BotReplyContext, handler: Promise<BotResponse>) {
    try {
      const reply = await handler;
      const payload = this.normalizeBotResponse(reply);
      const defaultExtra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(
        payload.text,
        this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      const extra = await this.getDefaultReplyMarkup(ctx);
      await ctx.reply(message, this.resolveReplyExtra(message, undefined, extra));
    }
  }

  private normalizeBotResponse(reply: BotResponse) {
    if (typeof reply === 'string') {
      return { text: reply, extra: undefined };
    }

    return reply;
  }

  private prependVoiceTranscript(reply: BotResponse, transcript: string): BotResponse {
    if (typeof reply === 'string') {
      return `Escuche: "${transcript}"\n\n${reply}`;
    }

    return {
      ...reply,
      text: `Escuche: "${this.escapeHtml(transcript)}"\n\n${reply.text}`,
    };
  }

  private resolveReplyExtra(
    text: string,
    preferredExtra?: unknown,
    fallbackExtra?: unknown,
  ) {
    const baseExtra = preferredExtra ?? fallbackExtra;
    if (!text.includes('<b>')) {
      return baseExtra;
    }

    return this.withHtml(baseExtra);
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
    userId?: string,
  ) {
    const text = ctx.message.text.trim().toLowerCase();
    if (!['si', 'sí', 'no', 'cancelar'].includes(text)) {
      return null;
    }

    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction) {
      return null;
    }

    if (
      pendingAction.type !== 'CREATE_FAMILY_CONFIRMATION' &&
      pendingAction.type !== 'JOIN_FAMILY_CONFIRMATION' &&
      pendingAction.type !== 'CREATE_TASK_CONFIRMATION'
    ) {
      return null;
    }

    await this.tasksService.clearPendingAction(String(ctx.chat.id));

    if (text === 'no' || text === 'cancelar') {
      return 'Listo, no hice ningun cambio.';
    }

    if (pendingAction.type === 'CREATE_FAMILY_CONFIRMATION') {
      const user = await this.usersService.createFamilyAdmin({
        familyName:
          pendingAction.familyName?.trim() ||
          `Familia de ${pendingAction.fallbackName}`,
        name: pendingAction.fallbackName,
        phoneNumber: pendingAction.phoneNumber,
        telegramUserId: pendingAction.telegramUserId,
        telegramChatId: pendingAction.telegramChatId,
        telegramUsername: pendingAction.telegramUsername,
      });

      return this.buildFamilyCreatedResponse(user.name, user.family.name);
    }

    if (pendingAction.type === 'JOIN_FAMILY_CONFIRMATION') {
      const user = await this.usersService.joinFamilyByInvite({
        familyId: pendingAction.familyId,
        name: pendingAction.fallbackName,
        phoneNumber: pendingAction.phoneNumber,
        telegramUserId: pendingAction.telegramUserId,
        telegramChatId: pendingAction.telegramChatId,
        telegramUsername: pendingAction.telegramUsername,
      });

      await ctx.reply('Cuenta vinculada correctamente.', Markup.removeKeyboard());
      return `Bienvenido ${user.name}. Quedaste vinculado a la familia ${user.family.name}.`;
    }

    const confirmedUserId = userId ?? (await this.requireRegisteredUser(ctx)).id;
    const task = await this.tasksService.createTaskForUser(
      confirmedUserId,
      pendingAction.dto,
    );

    return this.buildTaskCreatedResponse(
      String(ctx.chat.id),
      confirmedUserId,
      task,
    );
  }

  private async tryHandleCreateFamilySetup(ctx: BotTextContext) {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (
      !pendingAction ||
      pendingAction.type !== 'CREATE_FAMILY_CONFIRMATION' ||
      pendingAction.step !== 'FAMILY_NAME'
    ) {
      return null;
    }

    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'cancelar') {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, no hice ningun cambio.';
    }

    if (!text) {
      return {
        text: [
          this.bold('Necesito un nombre para crear la familia.'),
          this.bold('Escribe el nombre o responde "Cancelar".'),
        ].join('\n'),
        extra: this.withHtml(),
      };
    }

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      ...pendingAction,
      step: 'CONFIRM',
      familyName: text,
    });

    return {
      text: [
        this.bold(`La familia se creara como "${this.escapeHtml(text)}".`),
        '',
        this.bold(
          'Si continuas, creare la familia y te dejare como administrador.',
        ),
        this.bold('Responde "si" para continuar o "no" para cancelar.'),
      ].join('\n'),
      extra: this.withHtml(),
    };
  }

  private async tryHandleJoinFamilyInviteContact(
    ctx: BotContactContext,
    linkInput: {
      phoneNumber: string;
      telegramUserId: string;
      telegramChatId: string;
      telegramUsername?: string;
      fallbackName: string;
    },
  ) {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'JOIN_FAMILY_INVITE') {
      return null;
    }

    const existingUser = await this.usersService.findByPhoneNumberForLink(
      linkInput.phoneNumber,
    );
    if (existingUser) {
      if (existingUser.familyId !== pendingAction.familyId) {
        throw new BadRequestException(
          'Ese telefono ya pertenece a otra familia.',
        );
      }

      const user = await this.usersService.linkExistingTelegramAccount(
        existingUser.id,
        linkInput,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      await ctx.reply('Cuenta vinculada correctamente.', Markup.removeKeyboard());
      return `Bienvenido ${user.name}. Quedaste vinculado a la familia ${user.family.name}.`;
    }

    await this.tasksService.setPendingAction(String(ctx.chat.id), {
      type: 'JOIN_FAMILY_CONFIRMATION',
      familyId: pendingAction.familyId,
      familyName: pendingAction.familyName,
      phoneNumber: linkInput.phoneNumber,
      telegramUserId: linkInput.telegramUserId,
      telegramChatId: linkInput.telegramChatId,
      telegramUsername: linkInput.telegramUsername,
      fallbackName: linkInput.fallbackName,
    });

    return {
      text: [
        this.bold(
          `Te agregare a la familia "${this.escapeHtml(pendingAction.familyName)}".`,
        ),
        '',
        this.bold('Responde "si" para continuar o "no" para cancelar.'),
      ].join('\n'),
      extra: this.withHtml(),
    };
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
        return this.buildHelpHomeResponse();
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
      await ctx.reply(
        payload.text,
        this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
      );
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
        await ctx.reply(
          payload.text,
          this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      await ctx.answerCbQuery(message);
    }
  }

  private async safeHandleViewCallback(
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

      const result = await this.handleViewCallback(
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
        await ctx.reply(
          payload.text,
          this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
        );
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
        await ctx.reply(
          payload.text,
          this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      await ctx.answerCbQuery(message);
    }
  }

  private async safeHandleAlertsCallback(
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

      const result = await this.handleAlertsCallback(
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
        await ctx.reply(
          payload.text,
          this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      await ctx.answerCbQuery(message);
    }
  }

  private async safeHandleHelpCallback(
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

      const result = this.handleHelpCallback(data);
      await ctx.answerCbQuery(result.answerText);

      if (result.editText) {
        await ctx.editMessageText(result.editText, result.editExtra);
      } else if (result.clearMarkup) {
        await ctx.editMessageReplyMarkup(undefined);
      }

      if (result.reply) {
        const payload = this.normalizeBotResponse(result.reply);
        const defaultExtra = await this.getDefaultReplyMarkup(ctx);
        await ctx.reply(
          payload.text,
          this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
        );
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
        await ctx.reply(
          payload.text,
          this.resolveReplyExtra(payload.text, payload.extra, defaultExtra),
        );
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
      case CALLBACK_WIZARD_NOTE_YES:
        return this.handleWizardInput(ctx, user.id, WIZARD_NOTE_YES);
      case CALLBACK_WIZARD_NOTE_NO:
        return this.handleWizardInput(ctx, user.id, WIZARD_NOTE_NO);
      case CALLBACK_WIZARD_CONFIRM:
        return this.handleWizardInput(ctx, user.id, WIZARD_CONFIRM_CREATE);
      default:
        if (data.startsWith('wizard:assignee:set:')) {
          const assigneeToken = data.replace('wizard:assignee:set:', '');
          return this.handleWizardInput(ctx, user.id, `ASSIGNEE:${assigneeToken}`);
        }
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

    if (data.startsWith('edit:close:')) {
      const taskId = data.replace('edit:close:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cerrar',
        clearMarkup: true,
        reply: {
          text: [
            this.bold('Listo, la tarea quedo asi:'),
            '',
            this.formatTaskDetail(
              task,
              this.usersService.resolveTimezone(user),
              this.usersService.resolveReminderMinutesBefore(user),
            ),
          ].join('\n'),
          extra: this.withHtml(),
        },
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
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(task)),
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
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(task)),
      };
    }

    if (data.startsWith('edit:section:')) {
      const [, , section, taskId] = data.split(':');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      return {
        answerText: 'Opciones de edicion',
        editText: this.formatEditSectionMenu(
          task,
          section,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditSectionKeyboard(task, section)),
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
          this.bold(`Editar titulo de "${task.title}"`),
          '',
          this.bold('Escribe el nuevo titulo.'),
          'Si prefieres salir, responde "Cancelar".',
        ].join('\n'),
        editExtra: this.withHtml(this.buildEditInputKeyboard(task.id)),
      };
    }

    if (data.startsWith('edit:field:scope:')) {
      const taskId = data.replace('edit:field:scope:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      return {
        answerText: 'Editar tipo',
        editText: this.formatTaskScopeMenu(task),
        editExtra: this.withHtml(this.buildTaskScopeKeyboard(task.id)),
      };
    }

    if (data.startsWith('edit:field:assignee:')) {
      const taskId = data.replace('edit:field:assignee:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      const members = await this.usersService.listFamilyUsers(user.id);
      return {
        answerText: 'Editar asignacion',
        editText: await this.formatTaskAssigneeMenu(user.id, task),
        editExtra: this.withHtml(
          this.buildTaskAssigneeKeyboard(
            task.id,
            task.assignedToUserId ?? null,
            members,
          ),
        ),
      };
    }

    if (data.startsWith('edit:field:due:')) {
      const taskId = data.replace('edit:field:due:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      return {
        answerText: 'Editar fecha',
        editText: [
          this.bold(`Editar fecha/hora de "${task.title}"`),
          '',
          this.bold(
            'Elige una opcion rapida o toca "Otro..." para escribir una fecha/hora personalizada.',
          ),
        ].join('\n'),
        editExtra: this.withHtml(this.buildEditDueDateKeyboard(task.id)),
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
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(updatedTask)),
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
          this.bold(`Editar fecha/hora de "${task.title}"`),
          '',
          this.bold(
            'Escribe la nueva fecha y hora, por ejemplo "mañana 18:00".',
          ),
          'Si prefieres salir, responde "Cancelar".',
        ].join('\n'),
        editExtra: this.withHtml(this.buildEditDueDateKeyboard(task.id)),
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
          this.bold(`Editar nota de "${task.title}"`),
          '',
          task.description?.trim()
            ? `Nota actual:\n${task.description}`
            : 'Actualmente no tiene nota.',
          '',
          this.bold(
            'Escribe la nueva nota. Puede tener varias lineas y hasta 1500 caracteres.',
          ),
          'Si prefieres salir, responde "Cancelar".',
        ].join('\n'),
        editExtra: this.withHtml(this.buildEditNoteKeyboard(task)),
      };
    }

    if (data.startsWith('edit:field:reminder:')) {
      const taskId = data.replace('edit:field:reminder:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      return {
        answerText: 'Editar alerta',
        editText: this.formatTaskReminderMenu(
          task,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildTaskReminderKeyboard(task.id)),
      };
    }

    if (data.startsWith('edit:scope:set:')) {
      const [, , , taskId, value] = data.split(':');
      const scope = value === 'family' ? TaskScope.FAMILY : TaskScope.PERSONAL;
      const task = await this.tasksService.updateTaskScope(
        user.id,
        taskId,
        scope,
      );
      return {
        answerText: 'Tipo actualizado',
        editText: this.formatEditSectionMenu(
          task,
          'content',
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(
          this.buildEditSectionKeyboard(task, 'content'),
        ),
      };
    }

    if (data.startsWith('edit:assignee:set:')) {
      const [, , , taskId, value] = data.split(':');
      const members = await this.usersService.listFamilyUsers(user.id);
      const assignedToUserId =
        value === 'unassigned'
          ? null
          : members[Number(value)]?.id ?? null;

      if (value !== 'unassigned' && assignedToUserId == null) {
        throw new BadRequestException(
          'La persona seleccionada ya no esta disponible en tu familia.',
        );
      }

      const task = await this.tasksService.updateTaskAssignee(
        user.id,
        taskId,
        assignedToUserId,
      );
      return {
        answerText: 'Asignacion actualizada',
        editText: this.formatEditSectionMenu(
          task,
          'content',
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(
          this.buildEditSectionKeyboard(task, 'content'),
        ),
      };
    }

    if (data.startsWith('edit:reminder:set:')) {
      const [, , , taskId, value] = data.split(':');
      const reminderMinutesBefore = value === 'default' ? null : Number(value);
      const task = await this.tasksService.updateTaskReminderMinutesBefore(
        user.id,
        taskId,
        reminderMinutesBefore,
      );
      return {
        answerText: 'Alerta actualizada',
        editText: this.formatEditTaskMenu(
          task,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(task)),
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
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(task)),
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
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(task)),
      };
    }

    return {
      answerText: undefined,
      clearMarkup: false,
    };
  }

  private async handleViewCallback(
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

    if (data === CALLBACK_VIEW_START || data === 'view:back:list') {
      return this.startViewTaskSelection(ctx, user.id);
    }

    if (data.startsWith('view:detail:')) {
      const taskId = data.replace('view:detail:', '');
      const task = await this.tasksService.getVisibleTaskById(user.id, taskId);

      return {
        answerText: 'Detalle',
        editText: this.formatTaskDetail(
          task,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildViewTaskDetailKeyboard(task.id)),
      };
    }

    if (data.startsWith('view:select:')) {
      const index = Number(data.replace('view:select:', ''));
      const task = await this.tasksService.getVisibleTaskByIndex(
        user.id,
        String(ctx.chat.id),
        index,
      );

      return {
        answerText: 'Tarea seleccionada',
        editText: this.formatTaskDetail(
          task,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildViewTaskDetailKeyboard(task.id)),
      };
    }

    if (data.startsWith('view:complete:ask:')) {
      const taskId = data.replace('view:complete:ask:', '');
      const task = await this.tasksService.getVisibleTaskById(user.id, taskId);
      return {
        answerText: 'Confirmar',
        editText: this.formatTaskCompleteConfirmPrompt(task),
        editExtra: this.withHtml(
          this.buildTaskCompleteConfirmKeyboard(task.id),
        ),
      };
    }

    if (data.startsWith('view:complete:confirm:')) {
      const taskId = data.replace('view:complete:confirm:', '');
      await this.tasksService.completeTaskById(user.id, taskId);
      return {
        answerText: 'Completada',
        clearMarkup: true,
        reply: 'Listo, tarea completada.',
      };
    }

    if (data.startsWith('view:complete:cancel:')) {
      const taskId = data.replace('view:complete:cancel:', '');
      const task = await this.tasksService.getVisibleTaskById(user.id, taskId);
      return {
        answerText: 'Cancelado',
        editText: this.formatTaskDetail(
          task,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildViewTaskDetailKeyboard(task.id)),
      };
    }

    if (data.startsWith('view:edit:')) {
      const taskId = data.replace('view:edit:', '');
      const task = await this.tasksService.getEditableTaskById(user.id, taskId);
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Editar tarea',
        editText: this.formatEditTaskMenu(
          task,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
        editExtra: this.withHtml(this.buildEditTaskKeyboard(task)),
      };
    }

    if (data.startsWith('view:close:')) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cerrar',
        clearMarkup: true,
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
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cancelado',
        editText: this.formatFamilyManagementText(user.family.name),
        editExtra: this.withHtml(this.buildFamilyManagementKeyboard()),
      };
    }

    if (data === CALLBACK_FAMILY_CLOSE) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        answerText: 'Cerrado',
        clearMarkup: true,
      };
    }

    if (data === CALLBACK_FAMILY_VIEW_MEMBERS) {
      const members = await this.usersService.listFamilyMembersForAdmin(user.id);
      return {
        answerText: 'Miembros',
        editText: this.formatFamilyMembersPrompt(members),
        editExtra: this.withHtml(this.buildFamilyMembersKeyboard(members)),
      };
    }

    if (data === CALLBACK_FAMILY_INVITE_MEMBER || data === 'family:add_member') {
      const inviteLink = await this.buildFamilyInviteLink(user.familyId);
      return {
        answerText: 'Link de invitacion',
        clearMarkup: true,
        reply: {
          text: [
            this.bold('Link de invitacion familiar'),
            '',
            'Comparte este link con las personas que quieres sumar a la familia:',
            this.escapeHtml(inviteLink),
            '',
            'Cuando abran el link, el bot les pedira compartir su contacto para vincularlos.',
          ].join('\n'),
          extra: this.withHtml(this.buildFamilyInviteKeyboard(inviteLink)),
        },
      };
    }

    if (data.startsWith('family:member:view:')) {
      const memberUserId = data.replace('family:member:view:', '');
      const member = await this.usersService.getFamilyMemberForAdmin(
        user.id,
        memberUserId,
      );

      return {
        answerText: 'Detalle del miembro',
        editText: this.formatFamilyMemberDetail(member),
        editExtra: this.withHtml(this.buildFamilyMemberDetailKeyboard(member)),
      };
    }

    if (data.startsWith('family:member:rename:')) {
      const memberUserId = data.replace('family:member:rename:', '');
      const member = await this.usersService.getFamilyMemberForAdmin(
        user.id,
        memberUserId,
      );
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'RENAME_FAMILY_MEMBER_WIZARD',
        memberUserId,
      });

      return {
        answerText: 'Editar nombre',
        clearMarkup: true,
        reply: [
          this.bold(`Nombre actual: "${member.name}"`),
          '',
          this.bold('Escribe el nuevo nombre del integrante.'),
          this.bold('Si prefieres salir, responde "Cancelar".'),
        ].join('\n'),
      };
    }

    if (data.startsWith('family:member:reset_link:')) {
      const memberUserId = data.replace('family:member:reset_link:', '');
      const member = await this.usersService.getFamilyMemberForAdmin(
        user.id,
        memberUserId,
      );

      return {
        answerText: 'Confirmar reset',
        editText: this.formatFamilyMemberResetPrompt(member),
        editExtra: this.withHtml(
          this.buildFamilyMemberResetConfirmKeyboard(member.id),
        ),
      };
    }

    if (data.startsWith('family:member:reset_confirm:')) {
      const memberUserId = data.replace('family:member:reset_confirm:', '');
      const member = await this.usersService.resetFamilyMemberTelegramForAdmin(
        user.id,
        memberUserId,
      );

      return {
        answerText: 'Vinculacion reseteada',
        editText: [
          this.bold('Vinculacion reseteada'),
          '',
          this.formatFamilyMemberDetail(member),
        ].join('\n'),
        editExtra: this.withHtml(this.buildFamilyMemberDetailKeyboard(member)),
      };
    }

    if (data.startsWith('family:member:remove:')) {
      const memberUserId = data.replace('family:member:remove:', '');
      const member = await this.usersService.getFamilyMemberForAdmin(
        user.id,
        memberUserId,
      );

      return {
        answerText: 'Confirmar eliminacion',
        editText: this.formatFamilyMemberRemovalPrompt(member),
        editExtra: this.withHtml(
          this.buildFamilyMemberRemovalConfirmKeyboard(member.id),
        ),
      };
    }

    if (data.startsWith('family:member:remove_confirm:')) {
      const memberUserId = data.replace('family:member:remove_confirm:', '');
      const removedUser = await this.usersService.deactivateManagedUser(
        user.id,
        memberUserId,
      );
      const members = await this.usersService.listFamilyMembersForAdmin(user.id);

      return {
        answerText: 'Integrante quitado',
        editText: this.formatFamilyMembersPrompt(members),
        editExtra: this.withHtml(this.buildFamilyMembersKeyboard(members)),
        reply: `Listo. Quite a ${removedUser.name} de la familia.`,
      };
    }

    if (
      data === CALLBACK_FAMILY_ADD_MEMBER_MANUAL ||
      data === 'family:invite_link'
    ) {
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'ADD_MEMBER_WIZARD',
        step: 'NAME',
        draft: {},
      });
      return {
        answerText: 'Agregar miembro',
        clearMarkup: true,
        reply: [
          this.bold('Vamos a agregar un miembro.'),
          '',
          this.bold('Primero, escribe el nombre con el que quieres guardarlo.'),
          this.bold('Despues te pedire que compartas su contacto.'),
        ].join('\n'),
      };
    }

    if (data === CALLBACK_FAMILY_SKIP_ONBOARDING) {
      return {
        answerText: 'Omitido',
        clearMarkup: true,
      };
    }

    if (data === CALLBACK_FAMILY_RENAME) {
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'RENAME_FAMILY_WIZARD',
      });
      return {
        answerText: 'Renombrar familia',
        clearMarkup: true,
        reply: [
          this.bold(`El nombre actual es "${user.family.name}".`),
          '',
          this.bold('Escribe el nuevo nombre de la familia.'),
          this.bold('Si prefieres salir, responde "Cancelar".'),
        ].join('\n'),
      };
    }

    if (data === CALLBACK_FAMILY_START_REMOVE) {
      const members = await this.usersService.listManagedUsers(user.id);
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'FAMILY_REMOVE_WIZARD',
        memberIds: members.map((member) => member.id),
        selectedMemberIds: [],
      });

      return {
        answerText: 'Quitar miembro',
        editText: this.formatFamilyRemovalPrompt(members, []),
        editExtra: this.withHtml(this.buildFamilyRemovalKeyboard(members, [])),
      };
    }

    if (data === CALLBACK_FAMILY_START_TRANSFER) {
      const members = await this.usersService.listTransferableAdminUsers(
        user.id,
      );
      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'FAMILY_TRANSFER_ADMIN_WIZARD',
        memberIds: members.map((member) => member.id),
        selectedMemberId: undefined,
      });

      return {
        answerText: 'Traspasar administracion',
        editText: this.formatFamilyTransferPrompt(members),
        editExtra: this.withHtml(
          this.buildFamilyTransferKeyboard(members, undefined),
        ),
      };
    }

    if (data.startsWith('family:toggle_remove:')) {
      const targetUserId = data.replace('family:toggle_remove:', '');
      const pendingAction = await this.tasksService.getPendingAction(
        String(ctx.chat.id),
      );
      const members = await this.usersService.listManagedUsers(user.id);
      if (!pendingAction || pendingAction.type !== 'FAMILY_REMOVE_WIZARD') {
        throw new BadRequestException(
          'No hay una seleccion de integrantes activa.',
        );
      }

      const target = members.find((member) => member.id === targetUserId);
      if (!target) {
        throw new BadRequestException(
          'Ese usuario ya no esta disponible para quitar.',
        );
      }

      const selectedMemberIds = pendingAction.selectedMemberIds.includes(
        targetUserId,
      )
        ? pendingAction.selectedMemberIds.filter((id) => id !== targetUserId)
        : [...pendingAction.selectedMemberIds, targetUserId];

      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'FAMILY_REMOVE_WIZARD',
        memberIds: pendingAction.memberIds,
        selectedMemberIds,
      });

      return {
        answerText: selectedMemberIds.includes(targetUserId)
          ? 'Seleccionado'
          : 'Quitado',
        editText: this.formatFamilyRemovalPrompt(members, selectedMemberIds),
        editExtra: this.withHtml(
          this.buildFamilyRemovalKeyboard(members, selectedMemberIds),
        ),
      };
    }

    if (data === CALLBACK_FAMILY_CONFIRM_REMOVE) {
      const pendingAction = await this.tasksService.getPendingAction(
        String(ctx.chat.id),
      );
      if (!pendingAction || pendingAction.type !== 'FAMILY_REMOVE_WIZARD') {
        throw new BadRequestException(
          'No hay una seleccion de integrantes activa.',
        );
      }

      if (pendingAction.selectedMemberIds.length === 0) {
        throw new BadRequestException('Selecciona al menos un integrante.');
      }

      const removedUsers = await this.usersService.deactivateManagedUsers(
        user.id,
        pendingAction.selectedMemberIds,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        answerText: 'Integrantes quitados',
        editText: this.formatFamilyManagementText(user.family.name),
        editExtra: this.withHtml(this.buildFamilyManagementKeyboard()),
        reply: `Listo. Quite ${removedUsers.length} integrante${removedUsers.length === 1 ? '' : 's'} de la familia.`,
      };
    }

    if (data.startsWith('family:transfer:select:')) {
      const targetUserId = data.replace('family:transfer:select:', '');
      const pendingAction = await this.tasksService.getPendingAction(
        String(ctx.chat.id),
      );
      const members = await this.usersService.listTransferableAdminUsers(
        user.id,
      );
      if (
        !pendingAction ||
        pendingAction.type !== 'FAMILY_TRANSFER_ADMIN_WIZARD'
      ) {
        throw new BadRequestException(
          'No hay un traspaso de administracion activo.',
        );
      }

      const target = members.find((member) => member.id === targetUserId);
      if (!target) {
        throw new BadRequestException(
          'Ese usuario ya no esta disponible para recibir la administracion.',
        );
      }

      await this.tasksService.setPendingAction(String(ctx.chat.id), {
        type: 'FAMILY_TRANSFER_ADMIN_WIZARD',
        memberIds: pendingAction.memberIds,
        selectedMemberId: targetUserId,
      });

      return {
        answerText: 'Seleccionado',
        editText: this.formatFamilyTransferConfirmation(target.name),
        editExtra: this.withHtml(
          this.buildFamilyTransferConfirmKeyboard(targetUserId),
        ),
      };
    }

    if (data.startsWith('family:transfer:confirm:')) {
      const targetUserId = data.replace('family:transfer:confirm:', '');
      const pendingAction = await this.tasksService.getPendingAction(
        String(ctx.chat.id),
      );
      if (
        !pendingAction ||
        pendingAction.type !== 'FAMILY_TRANSFER_ADMIN_WIZARD' ||
        pendingAction.selectedMemberId !== targetUserId
      ) {
        throw new BadRequestException(
          'No hay un traspaso de administracion activo.',
        );
      }

      const newAdmin = await this.usersService.transferFamilyAdministration(
        user.id,
        targetUserId,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        answerText: 'Administracion transferida',
        editText:
          'Listo. La administracion de la familia fue transferida correctamente.',
        clearMarkup: true,
        reply: `Listo. ${newAdmin?.name ?? 'La persona seleccionada'} ahora es quien administra la familia.`,
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
        this.bold(`Perfecto. Guardare a la persona como "${text}".`),
        '',
        this.bold(
          'Ahora comparte su contacto desde Telegram para tomar el numero.',
        ),
        this.bold('Si prefieres salir, responde "Cancelar".'),
      ].join('\n');
    }

    return {
      text: this.bold(
        'Estoy esperando que compartas el contacto de esa persona.',
      ),
      extra: this.withHtml(),
    };
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

  private async tryHandleRenameFamilyText(
    ctx: BotTextContext,
  ): Promise<BotResponse | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (!pendingAction || pendingAction.type !== 'RENAME_FAMILY_WIZARD') {
      return null;
    }

    const text = ctx.message.text.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, cancelé el cambio de nombre de la familia.';
    }

    if (!text) {
      throw new BadRequestException(
        'Escribe un nombre válido para la familia.',
      );
    }

    const user = await this.requireRegisteredUser(ctx);
    const family = await this.usersService.renameFamily(user.id, text);
    await this.tasksService.clearPendingAction(String(ctx.chat.id));

    return {
      text: this.bold(`Listo. La familia ahora se llama "${family.name}".`),
      extra: this.withHtml(this.buildFamilyManagementKeyboard()),
    };
  }

  private async tryHandleRenameFamilyMemberText(
    ctx: BotTextContext,
  ): Promise<BotResponse | null> {
    const pendingAction = await this.tasksService.getPendingAction(
      String(ctx.chat.id),
    );
    if (
      !pendingAction ||
      pendingAction.type !== 'RENAME_FAMILY_MEMBER_WIZARD'
    ) {
      return null;
    }

    const text = ctx.message.text.trim();
    const lowered = text.toLowerCase();

    if (lowered === 'cancelar' || text === MENU_CANCEL) {
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return 'Listo, cancelé el cambio de nombre del integrante.';
    }

    if (!text) {
      throw new BadRequestException(
        'Escribe un nombre valido para el integrante.',
      );
    }

    const user = await this.requireRegisteredUser(ctx);
    const member = await this.usersService.renameFamilyMemberForAdmin(
      user.id,
      pendingAction.memberUserId,
      text,
    );
    await this.tasksService.clearPendingAction(String(ctx.chat.id));

    return {
      text: [
        this.bold('Nombre actualizado'),
        '',
        this.formatFamilyMemberDetail(member),
      ].join('\n'),
      extra: this.withHtml(this.buildFamilyMemberDetailKeyboard(member)),
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
      editExtra: this.withHtml(
        this.buildBulkSelectionKeyboard(mode, tasks, []),
      ),
    };
  }

  private async startViewTaskSelection(
    ctx: BotReplyContext,
    userId: string,
  ): Promise<BulkCallbackResult> {
    let tasks = await this.tasksService.getTasksFromContext(
      String(ctx.chat.id),
    );
    if (tasks.length === 0) {
      tasks = await this.tasksService.listPendingTasks(userId);
      await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    }

    if (tasks.length === 0) {
      throw new BadRequestException(
        'No hay una lista reciente con tareas para revisar.',
      );
    }

    return {
      answerText: undefined,
      editText: this.formatViewSelectionPrompt(
        tasks,
        this.usersService.resolveTimezone(
          await this.usersService.requireActiveUser(userId),
        ),
      ),
      editExtra: this.withHtml(this.buildViewSelectionKeyboard(tasks)),
    };
  }

  private async startEditTaskSelection(
    ctx: BotReplyContext,
    userId: string,
  ): Promise<BulkCallbackResult> {
    let tasks = await this.tasksService.getTasksFromContext(
      String(ctx.chat.id),
    );
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
      editExtra: this.withHtml(this.buildEditSelectionKeyboard(tasks)),
    };
  }

  private async handleAlertsCallback(
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

    if (data === CALLBACK_ALERTS_CANCEL) {
      return {
        answerText: 'Cerrar',
        clearMarkup: true,
      };
    }

    if (data === CALLBACK_ALERTS_HOME) {
      return {
        answerText: 'Alertas',
        editText: this.formatAlertsHomeMenu(user),
        editExtra: this.withHtml(this.buildAlertsHomeKeyboard()),
      };
    }

    if (data === CALLBACK_ALERTS_SECTION_REMINDERS) {
      return {
        answerText: 'Recordatorios',
        editText: this.formatReminderSettingsMenu(user),
        editExtra: this.withHtml(this.buildUserReminderKeyboard()),
      };
    }

    if (data === CALLBACK_ALERTS_SECTION_BRIEFING) {
      return {
        answerText: 'Briefing diario',
        editText: this.formatBriefingSettingsMenu(user),
        editExtra: this.withHtml(this.buildUserBriefingKeyboard()),
      };
    }

    if (data.startsWith('alerts:user:set:')) {
      const value = data.replace('alerts:user:set:', '');
      const reminderMinutesBefore = value === 'default' ? null : Number(value);
      const updatedUser = await this.usersService.updateReminderMinutesBefore(
        user.id,
        reminderMinutesBefore,
      );

      return {
        answerText: 'Alerta actualizada',
        editText: this.formatReminderSettingsMenu(updatedUser),
        editExtra: this.withHtml(this.buildUserReminderKeyboard()),
      };
    }

    if (data.startsWith('alerts:briefing:set:')) {
      const value = data.replace('alerts:briefing:set:', '');
      const dailyBriefingTime =
        value === 'default' ? null : value.replace('-', ':');
      const updatedUser = await this.usersService.updateDailyBriefingTime(
        user.id,
        dailyBriefingTime,
      );

      return {
        answerText: 'Briefing actualizado',
        editText: this.formatBriefingSettingsMenu(updatedUser),
        editExtra: this.withHtml(this.buildUserBriefingKeyboard()),
      };
    }

    return {
      answerText: undefined,
      clearMarkup: false,
    };
  }

  private handleHelpCallback(data: string): BulkCallbackResult {
    if (data === CALLBACK_HELP_CANCEL) {
      return {
        answerText: 'Cerrar',
        clearMarkup: true,
      };
    }

    if (data === 'help:home') {
      return {
        answerText: 'Ayuda',
        editText: this.formatHelpHome(),
        editExtra: this.withHtml(this.buildHelpHomeKeyboard()),
      };
    }

    if (data.startsWith('help:section:')) {
      const section = data.replace('help:section:', '');
      return {
        answerText: 'Ayuda',
        editText: this.formatHelpSection(section),
        editExtra: this.withHtml(this.buildHelpSectionKeyboard()),
      };
    }

    return {
      answerText: undefined,
      clearMarkup: false,
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
      editExtra: this.withHtml(
        this.buildBulkSelectionKeyboard(mode, tasks, selectedTaskIds),
      ),
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
      const user = await this.usersService.requireActiveUser(userId);
      const task = await this.tasksService.getEditableTaskById(
        userId,
        pendingAction.taskId,
      );
      return {
        text: [
          this.bold('Listo, la tarea quedo asi:'),
          '',
          this.formatTaskDetail(
            task,
            this.usersService.resolveTimezone(user),
            this.usersService.resolveReminderMinutesBefore(user),
          ),
        ].join('\n'),
        extra: this.withHtml(),
      };
    }

    if (pendingAction.field === 'TITLE') {
      if (!text) {
        throw new BadRequestException('Escribe un titulo valido.');
      }

      const user = await this.usersService.requireActiveUser(userId);
      const updatedTask = await this.tasksService.updateTaskTitle(
        userId,
        pendingAction.taskId,
        text,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));
      return {
        text: [
          this.bold('Listo. Actualice el titulo de la tarea.'),
          '',
          this.formatEditTaskMenu(
            updatedTask,
            this.usersService.resolveTimezone(user),
            this.usersService.resolveReminderMinutesBefore(user),
          ),
        ].join('\n'),
        extra: this.withHtml(this.buildEditTaskKeyboard(updatedTask)),
      };
    }

    if (pendingAction.field === 'DUE_DATE') {
      const user = await this.usersService.requireActiveUser(userId);
      const dueDate = await this.resolveWizardDueDate(text, userId);
      const updatedTask = await this.tasksService.updateTaskDueDate(
        userId,
        pendingAction.taskId,
        dueDate,
      );
      await this.tasksService.clearPendingAction(String(ctx.chat.id));

      return {
        text: [
          this.bold('Listo. Actualice la fecha/hora de la tarea.'),
          '',
          this.formatEditTaskMenu(
            updatedTask,
            this.usersService.resolveTimezone(user),
            this.usersService.resolveReminderMinutesBefore(user),
          ),
        ].join('\n'),
        extra: this.withHtml(this.buildEditTaskKeyboard(updatedTask)),
      };
    }

    const user = await this.usersService.requireActiveUser(userId);
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
          ? this.bold('Listo. Actualice la nota de la tarea.')
          : this.bold('Listo. Quite la nota de la tarea.'),
        '',
        this.formatEditTaskMenu(
          updatedTask,
          this.usersService.resolveTimezone(user),
          this.usersService.resolveReminderMinutesBefore(user),
        ),
      ].join('\n'),
      extra: this.withHtml(this.buildEditTaskKeyboard(updatedTask)),
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
    const user = await this.usersService.requireActiveUser(userId);

    return {
      text: this.formatEditTaskMenu(
        task,
        this.usersService.resolveTimezone(user),
        this.usersService.resolveReminderMinutesBefore(user),
      ),
      extra: this.withHtml(this.buildEditTaskKeyboard(task)),
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

        if (scope === TaskScope.PERSONAL) {
          await this.tasksService.setPendingAction(String(ctx.chat.id), {
            type: 'CREATE_TASK_WIZARD',
            step: 'DUE_DATE',
            draft: {
              ...pendingAction.draft,
              scope,
              assignedToUserId: userId,
              assignedToUserName: null,
            },
          });
          return {
            text: '¿Para cuándo es? Escribe una fecha natural como "mañana 18:00" o "el viernes en la tarde". Si prefieres, usa el botón "Sin fecha".',
            extra: this.wizardDueDateInlineKeyboard,
          };
        }

        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'ASSIGNEE',
          draft: {
            ...pendingAction.draft,
            scope,
          },
        });
        return {
          text: await this.formatWizardAssigneePrompt(userId, null),
          extra: this.withHtml(await this.buildWizardAssigneeKeyboard(userId)),
        };
      }
      case 'ASSIGNEE': {
        const assigneeToken = text.replace(/^ASSIGNEE:/, '').trim();
        if (!text.startsWith('ASSIGNEE:')) {
          throw new BadRequestException(
            'Usa los botones para elegir a quien asignar la tarea.',
          );
        }

        const assignment = await this.resolveWizardAssigneeSelection(
          userId,
          assigneeToken,
        );
        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'DUE_DATE',
          draft: {
            ...pendingAction.draft,
            assignedToUserId: assignment.assignedToUserId,
            assignedToUserName: assignment.assignedToUserName,
          },
        });
        return {
          text: '¿Para cuándo es? Escribe una fecha natural como "mañana 18:00" o "el viernes en la tarde". Si prefieres, usa el botón "Sin fecha".',
          extra: this.wizardDueDateInlineKeyboard,
        };
      }
      case 'DUE_DATE': {
        const dueDate = await this.resolveWizardDueDate(text, userId);
        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'NOTE_DECISION',
          draft: {
            ...pendingAction.draft,
            dueDate,
            dueDateInput: text,
          },
        });
        return {
          text: '¿Quieres agregar una nota a la tarea?',
          extra: this.wizardNoteInlineKeyboard,
        };
      }
      case 'NOTE_DECISION': {
        const wantsNote = this.parseWizardNoteDecision(text);
        if (wantsNote == null) {
          throw new BadRequestException(
            'Responde "Si, agregar nota" o "No, continuar".',
          );
        }

        if (wantsNote) {
          await this.tasksService.setPendingAction(String(ctx.chat.id), {
            type: 'CREATE_TASK_WIZARD',
            step: 'NOTE_INPUT',
            draft: {
              ...pendingAction.draft,
            },
          });
          return {
            text: 'Escribe la nota que quieres guardar en la tarea. Puede tener hasta 1500 caracteres.',
            extra: this.withHtml(),
          };
        }

        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'PRIORITY',
          draft: {
            ...pendingAction.draft,
            description: null,
          },
        });
        return {
          text: '¿Que prioridad tiene?',
          extra: this.wizardPriorityInlineKeyboard,
        };
      }
      case 'NOTE_INPUT':
        await this.tasksService.setPendingAction(String(ctx.chat.id), {
          type: 'CREATE_TASK_WIZARD',
          step: 'PRIORITY',
          draft: {
            ...pendingAction.draft,
            description: text,
          },
        });
        return {
          text: '¿Que prioridad tiene?',
          extra: this.wizardPriorityInlineKeyboard,
        };
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
            description: pendingAction.draft.description ?? null,
            scope: pendingAction.draft.scope ?? TaskScope.PERSONAL,
            priority: pendingAction.draft.priority ?? Priority.MEDIUM,
            dueDate: pendingAction.draft.dueDate ?? null,
            assignedToUserId:
              pendingAction.draft.scope === TaskScope.PERSONAL
                ? userId
                : pendingAction.draft.assignedToUserId ?? null,
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
    return this.buildTaskCreatedResponse(String(ctx.chat.id), userId, task);
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

  private parseWizardNoteDecision(text: string) {
    const lowered = text.trim().toLowerCase();

    if (
      lowered === 'si' ||
      lowered === 'sí' ||
      lowered === 'si, agregar nota' ||
      lowered === 'sí, agregar nota'
    ) {
      return true;
    }

    if (lowered === 'no' || lowered === 'no, continuar') {
      return false;
    }

    return null;
  }

  private formatTaskDraftSummary(draft: {
    title?: string;
    scope?: TaskScope;
    assignedToUserId?: string | null;
    assignedToUserName?: string | null;
    dueDate?: string | null;
    dueDateInput?: string | null;
    description?: string | null;
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
      `Asignada a: ${this.formatAssigneeLabel(draft)}`,
      `Vence: ${dueDate}`,
      `Nota: ${draft.description?.trim() ?? 'Sin nota'}`,
      `Prioridad: ${this.formatPriorityLabel(draft.priority ?? Priority.MEDIUM)}`,
      '',
      'Responde "Crear tarea" o "si" para confirmarla.',
    ].join('\n');
  }

  private async resolveCreateTaskAssignee(
    userId: string,
    scope: TaskScope,
    assigneeName: string | null,
  ) {
    if (scope === TaskScope.PERSONAL) {
      return userId;
    }

    if (!assigneeName?.trim()) {
      return null;
    }

    const member = await this.findFamilyMemberByName(userId, assigneeName);
    if (!member) {
      throw new BadRequestException(
        `No encontre a "${assigneeName}" en tu familia.`,
      );
    }

    return member.id;
  }

  private async resolveWizardAssigneeSelection(userId: string, token: string) {
    if (token === 'unassigned') {
      return {
        assignedToUserId: null,
        assignedToUserName: null,
      };
    }

    const members = await this.usersService.listFamilyUsers(userId);
    const member = members.find((candidate) => candidate.id === token);

    if (!member) {
      throw new BadRequestException(
        'La persona seleccionada ya no esta disponible en tu familia.',
      );
    }

    return {
      assignedToUserId: member.id,
      assignedToUserName: member.name,
    };
  }

  private async formatWizardAssigneePrompt(
    userId: string,
    assignedToUserId: string | null,
  ) {
    const members = await this.usersService.listFamilyUsers(userId);
    const selected =
      members.find((member) => member.id === assignedToUserId)?.name ?? null;

    return [
      this.bold('¿A quien quieres asignar esta tarea familiar?'),
      '',
      `${this.bold('Seleccion actual:')} ${this.escapeHtml(selected ?? WIZARD_ASSIGNEE_NONE)}`,
      '',
      this.bold('Puedes dejarla sin asignar por ahora.'),
    ].join('\n');
  }

  private async buildWizardAssigneeKeyboard(userId: string) {
    const members = await this.usersService.listFamilyUsers(userId);
    const rows = members.map((member) => [
      Markup.button.callback(member.name, `wizard:assignee:set:${member.id}`),
    ]);

    rows.push([
      Markup.button.callback(
        WIZARD_ASSIGNEE_NONE,
        'wizard:assignee:set:unassigned',
      ),
    ]);
    rows.push([Markup.button.callback(MENU_CANCEL, CALLBACK_WIZARD_CANCEL)]);

    return Markup.inlineKeyboard(rows);
  }

  private async formatTaskAssigneeMenu(
    userId: string,
    task: DisplayTask & { id?: string },
  ) {
    return [
      this.bold(`Editar asignacion de "${task.title}"`),
      `${this.bold('Valor actual:')} ${this.escapeHtml(this.formatAssigneeLabel(task))}`,
      '',
      this.bold('Selecciona a una persona de tu familia o deja la tarea sin asignar.'),
    ].join('\n');
  }

  private buildTaskAssigneeKeyboard(
    taskId: string,
    assignedToUserId: string | null,
    members: Array<{ id: string; name: string }>,
  ) {
    const rows = members.map((member) => [
      Markup.button.callback(
        `${assignedToUserId === member.id ? '✅ ' : ''}${member.name}`,
        `edit:assignee:set:${taskId}:${members.findIndex((candidate) => candidate.id === member.id)}`,
      ),
    ]);

    rows.push([
      Markup.button.callback(
        `${assignedToUserId == null ? '✅ ' : ''}${WIZARD_ASSIGNEE_NONE}`,
        `edit:assignee:set:${taskId}:unassigned`,
      ),
    ]);
    rows.push([
      Markup.button.callback(
        '⬅️ Volver',
        `${CALLBACK_EDIT_SECTION_CONTENT}:${taskId}`,
      ),
      Markup.button.callback('Cerrar', `edit:close:${taskId}`),
    ]);

    return Markup.inlineKeyboard(rows);
  }

  private async findFamilyMemberByName(userId: string, assigneeName: string) {
    const members = await this.usersService.listFamilyUsers(userId);
    const normalizedQuery = this.normalizeSearchText(assigneeName);
    const exact = members.find(
      (member) => this.normalizeSearchText(member.name) === normalizedQuery,
    );

    if (exact) {
      return exact;
    }

    const partialMatches = members.filter((member) =>
      this.normalizeSearchText(member.name).includes(normalizedQuery),
    );

    if (partialMatches.length === 1) {
      return partialMatches[0];
    }

    return null;
  }

  private normalizeSearchText(text: string) {
    return text
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
  }

  private formatAssigneeLabel(
    task:
      | DisplayTask
      | {
          scope?: TaskScope;
          assignedToUserId?: string | null;
          assignedToUserName?: string | null;
          assignedToUser?: { id: string; name: string } | null;
        },
  ) {
    if (task.scope === TaskScope.PERSONAL) {
      return task.assignedToUser?.name ?? task.assignedToUserName ?? 'Tarea personal';
    }

    return task.assignedToUser?.name ?? task.assignedToUserName ?? 'Sin asignar';
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
    const assigneeSuffix =
      task.scope === TaskScope.FAMILY && task.assignedToUser?.name
        ? ` · para ${task.assignedToUser.name}`
        : '';

    return `${overdueBadge ? `${overdueBadge} ` : ''}${badges}${noteBadge ? ` ${noteBadge}` : ''} ${task.title} · ${due}${assigneeSuffix}`.trim();
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
          Math.round(
            DateTime.now().setZone(timezone).diff(due, 'minutes').minutes,
          ),
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
    const title = this.escapeHtml(task.title);
    const assignee =
      task.scope === TaskScope.FAMILY && task.assignedToUser?.name
        ? ` asignada a ${this.escapeHtml(task.assignedToUser.name)}`
        : '';
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';
    const priority =
      task.priority === Priority.HIGH
        ? ' con prioridad alta ‼️'
        : task.priority === Priority.MEDIUM
          ? ' con prioridad media ❕'
          : '';
    return `"${title}" ${scope}${assignee}, ${due}${priority}.`;
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
      const tomorrow = now
        .plus({ days: 1 })
        .startOf('day')
        .set({
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

    return (
      DateTime.fromJSDate(task.dueDate).setZone(timezone) <
      DateTime.now().setZone(timezone)
    );
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
    defaultReminderMinutesBefore = this.configService.get<number>(
      'REMINDER_MINUTES_BEFORE',
      30,
    ),
  ) {
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';

    return [
      this.bold('Detalle de tarea'),
      `${this.bold('Titulo:')} ${this.escapeHtml(task.title)}`,
      `${this.bold('Tipo:')} ${this.escapeHtml(this.formatScopeLabel(task.scope))}`,
      ...(task.scope === TaskScope.FAMILY
        ? [
            `${this.bold('Creada por:')} ${this.escapeHtml(task.createdByUser?.name ?? 'Sin dato')}`,
          ]
        : []),
      `${this.bold('Asignada a:')} ${this.escapeHtml(this.formatAssigneeLabel(task))}`,
      `${this.bold('Vence:')} ${this.escapeHtml(due)}`,
      `${this.bold('Prioridad:')} ${this.escapeHtml(
        this.formatPriorityLabel(task.priority ?? Priority.MEDIUM),
      )}`,
      `${this.bold('Alerta:')} ${this.escapeHtml(
        this.formatReminderLabel(
          task.reminderMinutesBefore,
          defaultReminderMinutesBefore,
        ),
      )}`,
      '',
      this.bold('Nota:'),
      this.escapeHtml(task.description?.trim() || 'Sin nota.'),
    ].join('\n');
  }

  private formatReminderLabel(
    reminderMinutesBefore: number | null | undefined,
    defaultReminderMinutesBefore: number,
  ) {
    const effectiveValue =
      reminderMinutesBefore == null
        ? defaultReminderMinutesBefore
        : reminderMinutesBefore;

    if (effectiveValue === 0) {
      return reminderMinutesBefore == null
        ? 'Sin recordatorio (predeterminada)'
        : 'Sin recordatorio';
    }

    const label = this.formatMinutesLabel(effectiveValue);
    return reminderMinutesBefore == null ? `${label} (predeterminada)` : label;
  }

  private formatMinutesLabel(minutes: number) {
    if (minutes < 60) {
      return `${minutes} min antes`;
    }

    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `${hours} hora${hours === 1 ? '' : 's'} antes`;
    }

    return `${minutes} min antes`;
  }

  private withHtml(extra?: unknown) {
    return Object.assign(
      {
        parse_mode: 'HTML',
      },
      extra ?? {},
    );
  }

  private bold(text: string) {
    return `<b>${this.escapeHtml(text)}</b>`;
  }

  private escapeHtml(text: string) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private buildFamilyCreatedResponse(userName: string, familyName: string) {
    return {
      text: [
        `Bienvenido ${this.escapeHtml(userName)}. Se creo ${this.escapeHtml(familyName)} y quedaste como administrador.`,
        '',
        '¿Quieres generar un link para invitar integrantes ahora?',
      ].join('\n'),
      extra: this.withHtml(this.buildFamilyCreatedKeyboard()),
    };
  }

  private buildFamilyCreatedKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🔗 Generar link',
          CALLBACK_FAMILY_INVITE_MEMBER,
        ),
      ],
      [Markup.button.callback('Omitir', CALLBACK_FAMILY_SKIP_ONBOARDING)],
    ]);
  }

  private buildFamilyInviteKeyboard(inviteLink: string) {
    return Markup.inlineKeyboard([
      [Markup.button.url('Abrir link', inviteLink)],
      [Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE)],
    ]);
  }

  private async buildFamilyInviteLink(familyId: string) {
    const username = await this.getBotUsername();
    return `https://t.me/${username}?start=${FAMILY_INVITE_START_PREFIX}${familyId}`;
  }

  private async getBotUsername() {
    if (!this.bot) {
      throw new BadRequestException('Bot no disponible.');
    }

    if (this.bot.botInfo?.username) {
      return this.bot.botInfo.username;
    }

    const botInfo = await this.bot.telegram.getMe();
    this.bot.botInfo = botInfo;
    return botInfo.username;
  }

  private getStartPayload(ctx: BotReplyContext) {
    const message = (ctx as BotTextContext).message;
    if (!message || typeof message.text !== 'string') {
      return null;
    }

    const [command, ...rest] = message.text.trim().split(/\s+/);
    if (command !== '/start' || rest.length === 0) {
      return null;
    }

    return rest.join(' ').trim() || null;
  }

  private formatFamilyManagementText(familyName: string) {
    return [
      this.bold(`Gestion de ${familyName}`),
      '',
      this.bold('¿Que quieres hacer?'),
      '',
      this.bold('Miembros:'),
      this.escapeHtml(
        'Revisa quienes integran la familia y su estado de vinculacion.',
      ),
      '',
      this.bold('Altas:'),
      this.escapeHtml(
        'Invita con link o carga manualmente a una persona antes de que se vincule.',
      ),
      '',
      this.bold('Administracion:'),
      this.escapeHtml(
        'Puedes renombrar la familia, quitar integrantes o traspasar la administracion.',
      ),
    ].join('\n');
  }

  private buildFamilyManagementKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('👥 Ver miembros', CALLBACK_FAMILY_VIEW_MEMBERS)],
      [
        Markup.button.callback(
          '🔗 Invitar miembro',
          CALLBACK_FAMILY_INVITE_MEMBER,
        ),
      ],
      [
        Markup.button.callback(
          '➕ Agregar miembro manualmente',
          CALLBACK_FAMILY_ADD_MEMBER_MANUAL,
        ),
      ],
      [Markup.button.callback('✏️ Renombrar familia', CALLBACK_FAMILY_RENAME)],
      [
        Markup.button.callback(
          '👑 Traspasar administracion',
          CALLBACK_FAMILY_START_TRANSFER,
        ),
      ],
      [
        Markup.button.callback(
          '🗑️ Quitar miembro',
          CALLBACK_FAMILY_START_REMOVE,
        ),
      ],
      [Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE)],
    ]);
  }

  private formatFamilyMembersPrompt(
    members: Array<{
      id: string;
      name: string;
      phoneNumber: string;
      telegramChatId: string | null;
      role: UserRole;
    }>,
  ) {
    const lines =
      members.length === 0
        ? [this.bold('No hay integrantes activos en la familia.')]
        : members.map((member, index) => {
            const roleLabel =
              member.role === UserRole.FAMILY_ADMIN ? 'admin' : 'miembro';
            const statusLabel = member.telegramChatId ? 'vinculado' : 'pendiente';
            return `${this.bold(`${index + 1}.`)} ${this.escapeHtml(member.name)} · ${roleLabel} · ${statusLabel}`;
          });

    return [
      this.bold('Miembros de la familia'),
      '',
      this.bold(
        'Selecciona una persona para ver su detalle y estado de vinculacion.',
      ),
      '',
      lines.join('\n'),
    ].join('\n');
  }

  private buildFamilyMembersKeyboard(
    members: Array<{ id: string; name: string; role: UserRole }>,
  ) {
    const rows = members.map((member, index) => [
      Markup.button.callback(
        `${member.role === UserRole.FAMILY_ADMIN ? '👑' : '👤'} ${index + 1}. ${this.truncateTaskTitle(member.name, 18)}`,
        `family:member:view:${member.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback('⬅️ Volver', CALLBACK_FAMILY_CANCEL),
      Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
    ]);

    return Markup.inlineKeyboard(rows);
  }

  private formatFamilyMemberDetail(member: {
    name: string;
    phoneNumber: string;
    telegramUsername: string | null;
    telegramChatId: string | null;
    role: UserRole;
    createdAt: Date;
  }) {
    const linked = Boolean(member.telegramChatId);
    const linkedLabel = linked ? 'Vinculado' : 'Pendiente de vinculacion';
    const username = member.telegramUsername
      ? `@${member.telegramUsername}`
      : 'Sin username';
    const roleLabel =
      member.role === UserRole.FAMILY_ADMIN
        ? 'Administrador familiar'
        : 'Miembro';

    return [
      this.bold('Detalle del miembro'),
      `${this.bold('Nombre:')} ${this.escapeHtml(member.name)}`,
      `${this.bold('Rol:')} ${this.escapeHtml(roleLabel)}`,
      `${this.bold('Estado:')} ${this.escapeHtml(linkedLabel)}`,
      `${this.bold('Telefono:')} ${this.escapeHtml(member.phoneNumber)}`,
      `${this.bold('Telegram:')} ${this.escapeHtml(linked ? username : 'Aun no vinculado')}`,
      `${this.bold('Alta:')} ${this.escapeHtml(
        DateTime.fromJSDate(member.createdAt)
          .setZone('America/Santiago')
          .setLocale('es')
          .toFormat('dd/LL/yyyy HH:mm'),
      )}`,
    ].join('\n');
  }

  private formatFamilyMemberResetPrompt(member: {
    id: string;
    name: string;
    telegramChatId: string | null;
  }) {
    return [
      this.bold('Resetear vinculacion Telegram'),
      '',
      `${this.escapeHtml(member.name)} volvera a quedar como pendiente de vinculacion.`,
      'La persona tendra que hacer /start y compartir su contacto otra vez.',
      '',
      this.bold('¿Quieres continuar?'),
    ].join('\n');
  }

  private buildFamilyMemberDetailKeyboard(member: {
    id: string;
    role: UserRole;
    telegramChatId: string | null;
  }) {
    const rows = [
      [
        Markup.button.callback(
          '✏️ Editar nombre',
          `family:member:rename:${member.id}`,
        ),
      ],
      ...(member.role !== UserRole.FAMILY_ADMIN && member.telegramChatId
        ? [[
            Markup.button.callback(
              '🔄 Resetear vinculacion',
              `family:member:reset_link:${member.id}`,
            ),
          ]]
        : []),
      ...(member.role !== UserRole.FAMILY_ADMIN
        ? [[
            Markup.button.callback(
              '🗑️ Quitar miembro',
              `family:member:remove:${member.id}`,
            ),
          ]]
        : []),
      [
        Markup.button.callback(
          '⬅️ Volver a miembros',
          CALLBACK_FAMILY_VIEW_MEMBERS,
        ),
        Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
      ],
    ];

    return Markup.inlineKeyboard(rows);
  }

  private buildFamilyMemberResetConfirmKeyboard(memberUserId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✅ Confirmar reset',
          `family:member:reset_confirm:${memberUserId}`,
        ),
      ],
      [
        Markup.button.callback(
          '⬅️ Volver al detalle',
          `family:member:view:${memberUserId}`,
        ),
        Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
      ],
    ]);
  }

  private formatFamilyMemberRemovalPrompt(member: {
    id: string;
    name: string;
  }) {
    return [
      this.bold('Quitar miembro'),
      '',
      `${this.escapeHtml(member.name)} dejara de pertenecer a la familia y perdera su vinculacion actual con el bot.`,
      '',
      this.bold('¿Quieres continuar?'),
    ].join('\n');
  }

  private buildFamilyMemberRemovalConfirmKeyboard(memberUserId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✅ Confirmar eliminacion',
          `family:member:remove_confirm:${memberUserId}`,
        ),
      ],
      [
        Markup.button.callback(
          '⬅️ Volver al detalle',
          `family:member:view:${memberUserId}`,
        ),
        Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
      ],
    ]);
  }

  private formatFamilyTransferPrompt(members: Array<{ id: string; name: string }>) {
    if (members.length === 0) {
      return this.bold(
        'No hay integrantes vinculados al bot disponibles para recibir la administracion.',
      );
    }

    const lines = members.map(
      (member, index) =>
        `${this.bold(`${index + 1}.`)} ${this.escapeHtml(member.name)}`,
    );

    return [
      this.bold('Traspasar administracion'),
      '',
      this.bold(
        'Selecciona a una persona ya vinculada al bot para traspasar la administracion.',
      ),
      '',
      ...lines,
    ].join('\n');
  }

  private formatFamilyTransferConfirmation(targetName: string) {
    return [
      this.bold('Confirmar traspaso'),
      '',
      `La administracion pasara a ${this.bold(targetName)}.`,
      this.bold('Despues de confirmar, dejaras de ser administrador.'),
      this.bold('¿Quieres continuar?'),
    ].join('\n');
  }

  private buildFamilyTransferKeyboard(
    members: Array<{ id: string; name: string }>,
    selectedMemberId?: string,
  ) {
    const rows = members.map((member) => [
      Markup.button.callback(
        `${selectedMemberId === member.id ? '✅ ' : ''}${member.name}`,
        `family:transfer:select:${member.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback('⬅️ Volver', CALLBACK_FAMILY_CANCEL),
      Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
    ]);

    return Markup.inlineKeyboard(rows);
  }

  private buildFamilyTransferConfirmKeyboard(targetUserId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✅ Confirmar traspaso',
          `family:transfer:confirm:${targetUserId}`,
        ),
      ],
      [
        Markup.button.callback('⬅️ Volver', CALLBACK_FAMILY_CANCEL),
        Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
      ],
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
      return `${marker} ${this.bold(`${index + 1}.`)} ${this.escapeHtml(this.truncateTaskTitle(task.title))}`;
    });

    return [
      this.bold(`Selecciona las tareas que quieres ${actionLabel}.`),
      selectedCount > 0
        ? this.bold(
            `Llevas ${selectedCount} seleccionada${selectedCount === 1 ? '' : 's'}.`,
          )
        : this.bold('Aun no has seleccionado ninguna.'),
      '',
      lines.join('\n'),
    ].join('\n');
  }

  private formatFamilyRemovalPrompt(
    members: { id: string; name: string; phoneNumber: string }[],
    selectedMemberIds: string[],
  ) {
    const lines =
      members.length === 0
        ? [this.bold('No hay miembros para quitar por ahora.')]
        : members.map((member, index) => {
            const marker = selectedMemberIds.includes(member.id) ? '✅' : '☐';
            return `${marker} ${this.bold(`${index + 1}.`)} ${this.escapeHtml(member.name)} · ${this.escapeHtml(member.phoneNumber)}`;
          });

    return [
      this.bold('Quitar miembro'),
      selectedMemberIds.length > 0
        ? this.bold(
            `Llevas ${selectedMemberIds.length} seleccionad${selectedMemberIds.length === 1 ? 'o' : 'os'}.`,
          )
        : this.bold('Selecciona uno o varios integrantes.'),
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

  private buildFamilyRemovalKeyboard(
    members: { id: string; name: string }[],
    selectedMemberIds: string[],
  ) {
    const rows = members.map((member, index) => {
      const selected = selectedMemberIds.includes(member.id);
      const label = `${selected ? '✅' : '☐'} ${index + 1}. ${this.truncateTaskTitle(member.name, 18)}`;
      return [
        Markup.button.callback(label, `family:toggle_remove:${member.id}`),
      ];
    });

    rows.push([
      Markup.button.callback('🗑️ Eliminar', CALLBACK_FAMILY_CONFIRM_REMOVE),
    ]);
    rows.push([
      Markup.button.callback('⬅️ Volver', CALLBACK_FAMILY_CANCEL),
      Markup.button.callback('Cerrar', CALLBACK_FAMILY_CLOSE),
    ]);

    return Markup.inlineKeyboard(rows);
  }

  private formatEditSelectionPrompt(
    tasks: (DisplayTask & { id: string })[],
    timezone: string,
  ) {
    const lines = tasks.map(
      (task, index) =>
        `${this.bold(`${index + 1}.`)} ${this.formatTaskLine(task, timezone, false)}`,
    );

    return [
      this.bold('¿Que tarea quieres editar?'),
      '',
      lines.join('\n'),
      '',
      this.bold('Puedes tocar una opcion o responder solo con el numero.'),
    ].join('\n');
  }

  private formatViewSelectionPrompt(
    tasks: (DisplayTask & { id: string })[],
    timezone: string,
  ) {
    const lines = tasks.map(
      (task, index) =>
        `${this.bold(`${index + 1}.`)} ${this.formatTaskLine(task, timezone, false)}`,
    );

    return [
      this.bold('¿Que tarea quieres revisar?'),
      '',
      lines.join('\n'),
      '',
      this.bold('Toca una opcion para ver el detalle.'),
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

  private buildViewSelectionKeyboard(tasks: (DisplayTask & { id: string })[]) {
    const rows = tasks.map((task, index) => [
      Markup.button.callback(
        `${index + 1}. ${this.truncateTaskTitle(task.title, 18)}`,
        `view:select:${index + 1}`,
      ),
    ]);

    rows.push([Markup.button.callback('Cerrar', 'view:close:list')]);
    return Markup.inlineKeyboard(rows);
  }

  private formatEditTaskMenu(
    task: DisplayTask & { id?: string; description?: string | null },
    timezone: string,
    defaultReminderMinutesBefore = this.configService.get<number>(
      'REMINDER_MINUTES_BEFORE',
      30,
    ),
  ) {
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';

    return [
      this.bold('Editar tarea'),
      `${this.bold('Titulo:')} ${this.escapeHtml(task.title)}`,
      `${this.bold('Asignada a:')} ${this.escapeHtml(this.formatAssigneeLabel(task))}`,
      `${this.bold('Vence:')} ${this.escapeHtml(due)}`,
      `${this.bold('Nota:')} ${task.description?.trim() ? 'Sí' : 'No'}`,
      `${this.bold('Alerta:')} ${this.escapeHtml(
        this.formatReminderLabel(
          task.reminderMinutesBefore,
          defaultReminderMinutesBefore,
        ),
      )}`,
      '',
      this.bold('Elige un area para continuar.'),
    ].join('\n');
  }

  private buildEditTaskKeyboard(
    task: DisplayTask & { id: string; description?: string | null },
  ) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '📝 Contenido',
          `${CALLBACK_EDIT_SECTION_CONTENT}:${task.id}`,
        ),
        Markup.button.callback(
          '🗓️ Programacion',
          `${CALLBACK_EDIT_SECTION_SCHEDULE}:${task.id}`,
        ),
      ],
      [
        Markup.button.callback('⬅️ Cambiar tarea', 'edit:back:list'),
        Markup.button.callback('Cerrar', `edit:close:${task.id}`),
      ],
    ]);
  }

  private formatEditSectionMenu(
    task: DisplayTask & {
      id?: string;
      description?: string | null;
      reminderMinutesBefore?: number | null;
    },
    section: string,
    timezone: string,
    defaultReminderMinutesBefore = this.configService.get<number>(
      'REMINDER_MINUTES_BEFORE',
      30,
    ),
  ) {
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';

    if (section === 'content') {
      return [
        this.bold('Editar contenido'),
        `${this.bold('Titulo actual:')} ${this.escapeHtml(task.title)}`,
        `${this.bold('Tipo:')} ${this.escapeHtml(this.formatScopeLabel(task.scope))}`,
        `${this.bold('Asignada a:')} ${this.escapeHtml(this.formatAssigneeLabel(task))}`,
        `${this.bold('Nota:')} ${task.description?.trim() ? 'Sí' : 'No'}`,
        '',
        this.bold('¿Que parte del contenido quieres cambiar?'),
      ].join('\n');
    }

    return [
      this.bold('Editar programacion'),
      `${this.bold('Vence:')} ${this.escapeHtml(due)}`,
      `${this.bold('Alerta:')} ${this.escapeHtml(
        this.formatReminderLabel(
          task.reminderMinutesBefore,
          defaultReminderMinutesBefore,
        ),
      )}`,
      '',
      this.bold('¿Que parte de la programacion quieres cambiar?'),
    ].join('\n');
  }

  private buildEditSectionKeyboard(
    task: DisplayTask & {
      id: string;
      description?: string | null;
      reminderMinutesBefore?: number | null;
    },
    section: string,
  ) {
    const rows =
      section === 'content'
        ? [
            [
              Markup.button.callback(
                '✏️ Titulo',
                `edit:field:title:${task.id}`,
              ),
            ],
            [
              Markup.button.callback(
                '👤/👪 Tipo',
                `edit:field:scope:${task.id}`,
              ),
            ],
            ...(task.scope === TaskScope.FAMILY
              ? [[
                  Markup.button.callback(
                    '👥 Asignacion',
                    `edit:field:assignee:${task.id}`,
                  ),
                ]]
              : []),
            [
              Markup.button.callback(
                task.description?.trim() ? '📝 Editar nota' : '📝 Agregar nota',
                `edit:field:note:${task.id}`,
              ),
            ],
          ]
        : [
            [
              Markup.button.callback(
                '🕒 Fecha/Hora',
                `edit:field:due:${task.id}`,
              ),
            ],
            [
              Markup.button.callback(
                '🔔 Alerta',
                `edit:field:reminder:${task.id}`,
              ),
            ],
          ];

    rows.push([
      Markup.button.callback('⬅️ Volver', `edit:menu:${task.id}`),
      Markup.button.callback('Cerrar', `edit:close:${task.id}`),
    ]);

    return Markup.inlineKeyboard(rows);
  }

  private formatTaskScopeMenu(task: DisplayTask & { id: string }) {
    return [
      this.bold(`Editar tipo de "${task.title}"`),
      `${this.bold('Valor actual:')} ${this.escapeHtml(
        this.formatScopeLabel(task.scope),
      )}`,
      '',
      this.bold('Elige si la tarea debe ser personal o familiar.'),
    ].join('\n');
  }

  private buildTaskScopeKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '👤 Personal',
          `edit:scope:set:${taskId}:personal`,
        ),
        Markup.button.callback(
          '👪 Familiar',
          `edit:scope:set:${taskId}:family`,
        ),
      ],
      [
        Markup.button.callback(
          '⬅️ Volver',
          `${CALLBACK_EDIT_SECTION_CONTENT}:${taskId}`,
        ),
        Markup.button.callback('Cerrar', `edit:close:${taskId}`),
      ],
    ]);
  }

  private buildViewTaskDetailKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✅ Marcar como completada',
          `view:complete:ask:${taskId}`,
        ),
      ],
      [Markup.button.callback('✏️ Editar', `view:edit:${taskId}`)],
      [
        Markup.button.callback('⬅️ Volver', 'view:back:list'),
        Markup.button.callback('Cerrar', `view:close:${taskId}`),
      ],
    ]);
  }

  private formatTaskCompleteConfirmPrompt(
    task: DisplayTask & { id?: string; description?: string | null },
  ) {
    return [
      this.bold('Confirmar completado'),
      '',
      `¿Quieres marcar como completada "${this.escapeHtml(task.title)}"?`,
    ].join('\n');
  }

  private buildTaskCompleteConfirmKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '✅ Confirmar',
          `view:complete:confirm:${taskId}`,
        ),
      ],
      [Markup.button.callback('Cancelar', `view:complete:cancel:${taskId}`)],
    ]);
  }

  private buildEditInputKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('⬅️ Volver', `edit:menu:${taskId}`),
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
        Markup.button.callback('⬅️ Volver', `edit:menu:${taskId}`),
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
      Markup.button.callback('⬅️ Volver', `edit:menu:${task.id}`),
      Markup.button.callback('Cancelar', CALLBACK_EDIT_CANCEL),
    ]);

    return Markup.inlineKeyboard(rows);
  }

  private buildTaskReminderKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('10 min', `edit:reminder:set:${taskId}:10`),
        Markup.button.callback('30 min', `edit:reminder:set:${taskId}:30`),
      ],
      [
        Markup.button.callback('1 hora', `edit:reminder:set:${taskId}:60`),
        Markup.button.callback('2 horas', `edit:reminder:set:${taskId}:120`),
      ],
      [
        Markup.button.callback(
          'Sin recordatorio',
          `edit:reminder:set:${taskId}:0`,
        ),
        Markup.button.callback(
          'Usar predeterminada',
          `edit:reminder:set:${taskId}:default`,
        ),
      ],
      [
        Markup.button.callback('⬅️ Volver', `edit:menu:${taskId}`),
        Markup.button.callback('Cancelar', CALLBACK_EDIT_CANCEL),
      ],
    ]);
  }

  private buildAlertsHomeKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🔔 Recordatorios',
          CALLBACK_ALERTS_SECTION_REMINDERS,
        ),
      ],
      [
        Markup.button.callback(
          '☀️ Briefing diario',
          CALLBACK_ALERTS_SECTION_BRIEFING,
        ),
      ],
      [Markup.button.callback('Cerrar', CALLBACK_ALERTS_CANCEL)],
    ]);
  }

  private buildUserReminderKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('10 min', 'alerts:user:set:10'),
        Markup.button.callback('30 min', 'alerts:user:set:30'),
      ],
      [
        Markup.button.callback('1 hora', 'alerts:user:set:60'),
        Markup.button.callback('2 horas', 'alerts:user:set:120'),
      ],
      [
        Markup.button.callback('Sin recordatorio', 'alerts:user:set:0'),
        Markup.button.callback(
          'Usar valor familiar',
          'alerts:user:set:default',
        ),
      ],
      [
        Markup.button.callback('⬅️ Volver', CALLBACK_ALERTS_HOME),
        Markup.button.callback('Cerrar', CALLBACK_ALERTS_CANCEL),
      ],
    ]);
  }

  private buildUserBriefingKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('07:00', 'alerts:briefing:set:07-00'),
        Markup.button.callback('08:30', 'alerts:briefing:set:08-30'),
      ],
      [
        Markup.button.callback('09:00', 'alerts:briefing:set:09-00'),
        Markup.button.callback('10:00', 'alerts:briefing:set:10-00'),
      ],
      [
        Markup.button.callback(
          'Usar valor familiar',
          'alerts:briefing:set:default',
        ),
      ],
      [
        Markup.button.callback('⬅️ Volver', CALLBACK_ALERTS_HOME),
        Markup.button.callback('Cerrar', CALLBACK_ALERTS_CANCEL),
      ],
    ]);
  }

  private formatAlertsHomeMenu(
    user: NonNullable<Awaited<ReturnType<UsersService['findById']>>>,
  ) {
    return [
      this.bold('Alertas y briefing'),
      '',
      `${this.bold('Recordatorios por defecto:')} ${this.escapeHtml(
        this.formatReminderLabel(
          user.reminderMinutesBefore,
          this.usersService.resolveReminderMinutesBefore(user),
        ),
      )}`,
      '',
      `${this.bold('Briefing diario:')} ${this.escapeHtml(
        this.formatBriefingTimeLabel(
          user.dailyBriefingTime,
          this.usersService.resolveDailyBriefingTime(user),
        ),
      )}`,
      '',
      this.bold('Elige que quieres configurar.'),
    ].join('\n');
  }

  private formatReminderSettingsMenu(
    user: NonNullable<Awaited<ReturnType<UsersService['findById']>>>,
  ) {
    return [
      this.bold('Alertas predeterminadas'),
      `${this.bold('Valor actual:')} ${this.escapeHtml(
        this.formatReminderLabel(
          user.reminderMinutesBefore,
          this.usersService.resolveReminderMinutesBefore(user),
        ),
      )}`,
      '',
      this.bold(
        '¿Con cuanta anticipacion quieres recibir tus recordatorios por defecto?',
      ),
    ].join('\n');
  }

  private formatBriefingSettingsMenu(
    user: NonNullable<Awaited<ReturnType<UsersService['findById']>>>,
  ) {
    return [
      this.bold('Briefing diario'),
      `${this.bold('Hora actual:')} ${this.escapeHtml(
        this.formatBriefingTimeLabel(
          user.dailyBriefingTime,
          this.usersService.resolveDailyBriefingTime(user),
        ),
      )}`,
      '',
      this.bold('Elige a que hora quieres recibir tu resumen diario.'),
    ].join('\n');
  }

  private formatTaskReminderMenu(
    task: DisplayTask & { reminderMinutesBefore?: number | null },
    timezone: string,
    defaultReminderMinutesBefore: number,
  ) {
    const due = task.dueDate
      ? this.formatDueLabel(task.dueDate, timezone)
      : 'sin fecha';

    return [
      this.bold(`Editar alerta de "${task.title}"`),
      `${this.bold('Vence:')} ${this.escapeHtml(due)}`,
      `${this.bold('Valor actual:')} ${this.escapeHtml(
        this.formatReminderLabel(
          task.reminderMinutesBefore,
          defaultReminderMinutesBefore,
        ),
      )}`,
      '',
      this.bold('Elige una configuracion para esta tarea.'),
    ].join('\n');
  }

  private formatBriefingTimeLabel(
    dailyBriefingTime: string | null | undefined,
    fallbackDailyBriefingTime: string,
  ) {
    const resolvedTime = dailyBriefingTime ?? fallbackDailyBriefingTime;

    return dailyBriefingTime == null
      ? `${resolvedTime} (usa valor familiar)`
      : resolvedTime;
  }

  private buildHelpHomeResponse(): BotResponse {
    return {
      text: this.formatHelpHome(),
      extra: this.withHtml(this.buildHelpHomeKeyboard()),
    };
  }

  private formatHelpHome() {
    return [
      this.bold('Guia rapida del bot'),
      '',
      'Puedes usar el bot para crear tareas, ver pendientes, editar notas y fechas, configurar recordatorios y gestionar tu familia.',
      '',
      this.bold('Atajos utiles:'),
      '/nueva',
      '/pendientes',
      '/editar',
      '/alertas',
      '/ayuda',
      '',
      this.bold('Toca una categoria para ver ejemplos y pasos concretos.'),
    ].join('\n');
  }

  private buildHelpHomeKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📝 Tareas', 'help:section:tasks'),
        Markup.button.callback('📋 Listas', 'help:section:lists'),
      ],
      [
        Markup.button.callback('✏️ Edicion', 'help:section:editing'),
        Markup.button.callback('🔔 Recordatorios', 'help:section:alerts'),
      ],
      [
        Markup.button.callback('👨‍👩‍👧 Familia', 'help:section:family'),
        Markup.button.callback('⌨️ Comandos', 'help:section:commands'),
      ],
      [Markup.button.callback('Cerrar', CALLBACK_HELP_CANCEL)],
    ]);
  }

  private buildHelpSectionKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Volver a ayuda', 'help:home')],
      [Markup.button.callback('Cerrar', CALLBACK_HELP_CANCEL)],
    ]);
  }

  private formatHelpSection(section: string) {
    switch (section) {
      case 'tasks':
        return [
          this.bold('Tareas'),
          '',
          this.bold('Crear tareas rapido:'),
          'Escribe una frase normal, por ejemplo:',
          '- Comprar remedios mañana a las 18:00',
          '- Tarea familiar: pagar cuentas el viernes',
          '',
          this.bold('Crear tarea guiada:'),
          'Usa /nueva y el bot te pedira titulo, tipo, fecha y prioridad.',
          '',
          this.bold('Tipos:'),
          '👤 Personal: solo para ti.',
          '👪 Familiar: visible para la familia.',
        ].join('\n');
      case 'lists':
        return [
          this.bold('Listas y seguimiento'),
          '',
          this.bold('Comandos principales:'),
          '/pendientes',
          '/hoy',
          '/familiares',
          '/completadas',
          '',
          this.bold('Como leer las listas:'),
          '🚨 Tareas vencidas: tareas atrasadas.',
          '🗓️ Hoy: tareas que vencen hoy.',
          'Otras tareas: proximas o sin fecha.',
          '📝: la tarea tiene nota.',
          '',
          this.bold('Desde una lista reciente puedes usar:'),
          '/ver N',
          '/hecho N',
          '/eliminar N',
        ].join('\n');
      case 'editing':
        return [
          this.bold('Edicion de tareas'),
          '',
          this.bold('Abrir el editor:'),
          'Usa /editar y elige una tarea de la lista.',
          'Tambien puedes tocar el boton `Editar` desde pendientes.',
          '',
          this.bold('Que puedes cambiar:'),
          '- titulo',
          '- asignacion en tareas familiares',
          '- fecha y hora',
          '- nota',
          '- alerta',
          '',
          this.bold('Atajos de fecha/hora:'),
          '+30 min, +2 horas, Mañana, Sin fecha u Otro...',
        ].join('\n');
      case 'alerts':
        return [
          this.bold('Recordatorios y briefing'),
          '',
          this.bold('Configurar recordatorio predeterminado:'),
          'Usa /alertas para ajustar por separado tus recordatorios y la hora de tu briefing diario.',
          '',
          this.bold('Cambiar una sola tarea:'),
          'Entra a /editar, abre la tarea y toca `🔔 Alerta`.',
          '',
          this.bold('Como funciona la prioridad de alertas:'),
          '1. la alerta propia de la tarea',
          '2. tu alerta predeterminada',
          '3. la configuracion familiar',
          '4. la configuracion global del sistema',
          '',
          'Puedes dejar una tarea sin recordatorio.',
        ].join('\n');
      case 'family':
        return [
          this.bold('Familia'),
          '',
          this.bold('Administrador familiar:'),
          'Puede ver miembros, invitar, editar nombres, resetear vinculaciones y quitar integrantes.',
          '',
          this.bold('Agregar un integrante:'),
          'Usa /crearusuario Nombre +56912345678',
          'o entra a `Editar familia` para invitar con link o cargarlo manualmente.',
          '',
          this.bold('Vinculacion del integrante:'),
          'La persona debe escribir /start y compartir su contacto.',
          '',
          'Ser admin no permite ver tareas personales de otros integrantes.',
          'Las tareas familiares pueden ser vistas por la familia.',
          'Las tareas familiares asignadas solo pueden ser editadas o completadas por admins, quien la asigno o la persona asignada.',
        ].join('\n');
      case 'commands':
        return [
          this.bold('Comandos utiles'),
          '',
          '/start',
          '/ayuda',
          '/nueva',
          '/pendientes',
          '/hoy',
          '/familiares',
          '/completadas',
          '/ver 2',
          '/nota 2',
          '/editar',
          '/alertas',
          '/hecho 2',
          '/eliminar 2',
          '/crearusuario Nombre +56912345678',
        ].join('\n');
      default:
        return this.formatHelpHome();
    }
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

    return this.buildMainMenuKeyboard(user.role);
  }

  private buildMainMenuKeyboard(role: UserRole) {
    const rows =
      role === UserRole.FAMILY_ADMIN
        ? [
            [MENU_NEW_TASK, MENU_PENDING],
            [MENU_EDIT_FAMILY, MENU_HELP],
          ]
        : [[MENU_NEW_TASK, MENU_PENDING], [MENU_HELP]];

    return Markup.keyboard(rows).resize();
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

  private get wizardNoteInlineKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback(WIZARD_NOTE_YES, CALLBACK_WIZARD_NOTE_YES)],
      [Markup.button.callback(WIZARD_NOTE_NO, CALLBACK_WIZARD_NOTE_NO)],
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
      {
        command: 'alertas',
        description: 'Configurar alertas predeterminadas',
      },
      { command: 'editar', description: 'Editar una tarea pendiente' },
      { command: 'ayuda', description: 'Ver ayuda y ejemplos' },
    ]);
  }

  private get helpMessage() {
    return this.formatHelpHome();
  }
}
