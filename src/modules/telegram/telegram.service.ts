import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Priority, TaskScope, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
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

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Telegraf;

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
    void this.bot
      .launch()
      .then(() => {
        this.logger.log('Telegram bot iniciado.');
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Error desconocido';
        this.logger.error(`No se pudo iniciar Telegram: ${message}`);
      });
  }

  onModuleDestroy() {
    if (!this.bot) {
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

  private async handleListToday(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listTodayTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList('Tareas para hoy', tasks);
  }

  private async handleListPending(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listPendingTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList('Tareas pendientes', tasks);
  }

  private async handleListFamily(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listFamilyTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList('Tareas familiares', tasks);
  }

  private async handleListCompleted(ctx: BotTextContext) {
    const user = await this.requireRegisteredUser(ctx);
    const tasks = await this.tasksService.listCompletedTasks(user.id);
    await this.tasksService.storeTaskListContext(String(ctx.chat.id), tasks);
    return this.formatTaskList('Tareas completadas', tasks);
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
        const normalizedDueDate = this.normalizeDueDate(interpretation.dueDate);
        const dto = validateDto(CreateTaskDto, {
          title: interpretation.title ?? ctx.message.text,
          description: interpretation.description ?? null,
          scope: interpretation.scope ?? TaskScope.PERSONAL,
          priority: interpretation.priority ?? Priority.MEDIUM,
          dueDate: normalizedDueDate,
        });
        const task = await this.tasksService.createTaskForUser(user.id, dto);
        return `Tarea creada: ${task.title}`;
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
  ) {
    if (tasks.length === 0) {
      return `${title}\n\nNo hay tareas.`;
    }

    const lines = tasks.map((task, index) => {
      const due = task.dueDate
        ? ` - vence ${task.dueDate.toISOString().slice(0, 16).replace('T', ' ')}`
        : '';
      const scope = task.scope === TaskScope.FAMILY ? ' [FAMILIAR]' : '';
      const priority =
        task.priority && task.priority !== Priority.MEDIUM
          ? ` [${task.priority}]`
          : '';
      return `${index + 1}. ${task.title}${scope}${priority}${due}`;
    });

    return `${title}\n\n${lines.join('\n')}`;
  }

  private async safeReply(ctx: BotReplyContext, handler: Promise<string>) {
    try {
      const reply = await handler;
      await ctx.reply(reply);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ocurrio un error inesperado.';
      this.logger.warn(message);
      await ctx.reply(message);
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

  private get helpMessage() {
    return [
      'Comandos disponibles:',
      '/start',
      '/ayuda',
      '/crearusuario Nombre +56912345678',
      '/hoy',
      '/pendientes',
      '/listas',
      '/familiares',
      '/hecho 2',
      '/eliminar 2',
      '',
      'Tambien puedes escribir mensajes como:',
      'Comprar pan manana',
      'Tarea familiar: pagar cuentas',
    ].join('\n');
  }
}
