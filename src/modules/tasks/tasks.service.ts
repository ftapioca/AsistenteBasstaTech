import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  Priority,
  PrismaClient,
  Settings,
  Task,
  TaskScope,
  TaskStatus,
  User,
  UserRole,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from '../users/users.service';
import { CreateTaskDto } from './dto/create-task.dto';

type ActiveUser = NonNullable<Awaited<ReturnType<UsersService['findById']>>>;
const taskActorInclude = {
  assignedToUser: {
    select: {
      id: true,
      name: true,
    },
  },
  createdByUser: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.TaskInclude;
type TaskWithActors = Prisma.TaskGetPayload<{
  include: typeof taskActorInclude;
}>;
type ReminderTargetUser = Pick<
  User,
  'id' | 'telegramChatId' | 'isActive' | 'reminderMinutesBefore'
>;
type TaskWithReminderContext = Task & {
  assignedToUser: ReminderTargetUser | null;
  createdByUser: ReminderTargetUser;
  family: {
    settings: Settings | null;
    users: ReminderTargetUser[];
  };
};
type ReminderDeliveryKey = {
  taskId: string;
  userId: string;
  dueDateSnapshot: Date;
  channel?: 'TELEGRAM';
};
type ReminderDeliveryWrite = ReminderDeliveryKey & {
  effectiveReminderMinutesBefore: number;
  scheduledFor: Date;
  errorMessage?: string | null;
};
type DailyBriefingTask = Pick<
  Task,
  'id' | 'title' | 'scope' | 'dueDate' | 'priority' | 'description'
>;
type PendingAction =
  | {
      type: 'CREATE_TASK_CONFIRMATION';
      reason: 'AMBIGUOUS_DATE' | 'DUPLICATE_TASK';
      dto: CreateTaskDto;
      duplicateTaskTitle?: string;
    }
  | {
      type: 'CREATE_FAMILY_CONFIRMATION';
      step: 'FAMILY_NAME' | 'CONFIRM';
      phoneNumber: string;
      telegramUserId: string;
      telegramChatId: string;
      telegramUsername?: string | null;
      fallbackName: string;
      familyName?: string;
    }
  | {
      type: 'JOIN_FAMILY_INVITE';
      familyId: string;
      familyName: string;
    }
  | {
      type: 'JOIN_FAMILY_CONFIRMATION';
      familyId: string;
      familyName: string;
      phoneNumber: string;
      telegramUserId: string;
      telegramChatId: string;
      telegramUsername?: string | null;
      fallbackName: string;
    }
  | {
      type: 'CREATE_TASK_WIZARD';
      step:
        | 'TITLE'
        | 'SCOPE'
        | 'ASSIGNEE'
        | 'DUE_DATE'
        | 'NOTE_DECISION'
        | 'NOTE_INPUT'
        | 'PRIORITY'
        | 'CONFIRM';
      draft: {
        title?: string;
        scope?: TaskScope;
        assignedToUserId?: string | null;
        assignedToUserName?: string | null;
        dueDate?: string | null;
        dueDateInput?: string | null;
        description?: string | null;
        priority?: Priority;
      };
    }
  | {
      type: 'BULK_TASK_ACTION_WIZARD';
      mode: 'COMPLETE' | 'DELETE';
      taskIds: string[];
      selectedTaskIds: string[];
    }
  | {
      type: 'ADD_MEMBER_WIZARD';
      step: 'NAME' | 'CONTACT';
      draft: {
        name?: string;
      };
    }
  | {
      type: 'RENAME_FAMILY_WIZARD';
    }
  | {
      type: 'FAMILY_REMOVE_WIZARD';
      memberIds: string[];
      selectedMemberIds: string[];
    }
  | {
      type: 'FAMILY_TRANSFER_ADMIN_WIZARD';
      memberIds: string[];
      selectedMemberId?: string;
    }
  | {
      type: 'EDIT_TASK_SELECTION';
    }
  | {
      type: 'EDIT_TASK_INPUT';
      field: 'TITLE' | 'DUE_DATE' | 'NOTE';
      taskId: string;
    };

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  private get reminderDeliveryDelegate() {
    return (this.prisma as PrismaClient).taskReminderDelivery;
  }

  async createTaskForUser(userId: string, dto: CreateTaskDto) {
    const user = await this.usersService.requireActiveUser(userId);
    const assignedToUserId = await this.resolveAssignedUserId(user, dto);

    return this.prisma.task.create({
      data: {
        familyId: user.familyId,
        createdByUserId: user.id,
        assignedToUserId,
        title: dto.title,
        description: dto.description ?? null,
        priority: dto.priority ?? Priority.MEDIUM,
        scope: dto.scope,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        reminderMinutesBefore: dto.reminderMinutesBefore ?? null,
      },
      include: taskActorInclude,
    });
  }

  async findObviousDuplicateTask(userId: string, dto: CreateTaskDto) {
    const user = await this.usersService.requireActiveUser(userId);
    const title = normalizeTaskTitle(dto.title);
    const dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    const timezone = this.usersService.resolveTimezone(user);

    const candidates = await this.prisma.task.findMany({
      where: {
        familyId: user.familyId,
        status: TaskStatus.PENDING,
        scope: dto.scope,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return (
      candidates.find((task) => {
        if (normalizeTaskTitle(task.title) !== title) {
          return false;
        }

        if (!task.dueDate && !dueDate) {
          return true;
        }

        if (task.dueDate && dueDate) {
          const candidateDate = DateTime.fromJSDate(task.dueDate).setZone(
            timezone,
          );
          const targetDate = DateTime.fromJSDate(dueDate).setZone(timezone);

          if (candidateDate.hasSame(targetDate, 'day')) {
            return true;
          }

          return (
            Math.abs(task.dueDate.getTime() - dueDate.getTime()) <
            4 * 60 * 60 * 1000
          );
        }

        return false;
      }) ?? null
    );
  }

  async listTodayTasks(userId: string) {
    const user = await this.usersService.requireActiveUser(userId);
    const timezone = this.usersService.resolveTimezone(user);
    const now = DateTime.now().setZone(timezone);
    const start = now.startOf('day').toUTC().toJSDate();
    const end = now.endOf('day').toUTC().toJSDate();

    return this.prisma.task.findMany({
      where: {
        familyId: user.familyId,
        status: TaskStatus.PENDING,
        dueDate: {
          gte: start,
          lte: end,
        },
        ...this.visibilityWhere(user),
      },
      include: taskActorInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async listPendingTasks(userId: string) {
    const user = await this.usersService.requireActiveUser(userId);

    return this.prisma.task.findMany({
      where: {
        familyId: user.familyId,
        status: TaskStatus.PENDING,
        ...this.visibilityWhere(user),
      },
      include: taskActorInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async listFamilyTasks(userId: string) {
    const user = await this.usersService.requireActiveUser(userId);

    return this.prisma.task.findMany({
      where: {
        familyId: user.familyId,
        status: TaskStatus.PENDING,
        scope: TaskScope.FAMILY,
      },
      include: taskActorInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async listCompletedTasks(userId: string) {
    const user = await this.usersService.requireActiveUser(userId);

    return this.prisma.task.findMany({
      where: {
        familyId: user.familyId,
        status: TaskStatus.COMPLETED,
        ...this.visibilityWhere(user),
      },
      include: taskActorInclude,
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async storeTaskListContext(chatId: string, tasks: Task[]) {
    return this.prisma.chatContext.upsert({
      where: { chatId },
      create: {
        chatId,
        taskIdsJson: JSON.stringify(tasks.map((task) => task.id)),
        pendingActionJson: null,
      },
      update: {
        taskIdsJson: JSON.stringify(tasks.map((task) => task.id)),
      },
    });
  }

  async setPendingAction(chatId: string, pendingAction: PendingAction) {
    return this.prisma.chatContext.upsert({
      where: { chatId },
      create: {
        chatId,
        taskIdsJson: '[]',
        pendingActionJson: JSON.stringify(pendingAction),
      },
      update: {
        pendingActionJson: JSON.stringify(pendingAction),
      },
    });
  }

  async getPendingAction(chatId: string): Promise<PendingAction | null> {
    const context = await this.prisma.chatContext.findUnique({
      where: { chatId },
    });

    if (!context?.pendingActionJson) {
      return null;
    }

    const pendingActionJson = context.pendingActionJson;
    return JSON.parse(pendingActionJson) as PendingAction;
  }

  async clearPendingAction(chatId: string) {
    return this.prisma.chatContext.upsert({
      where: { chatId },
      create: {
        chatId,
        taskIdsJson: '[]',
        pendingActionJson: null,
      },
      update: {
        pendingActionJson: null,
      },
    });
  }

  async completeTaskByIndex(userId: string, chatId: string, index: number) {
    const task = await this.resolveTaskFromContext(chatId, index);
    const user = await this.usersService.requireActiveUser(userId);
    this.assertCanCompleteTask(user, task);

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  }

  async cancelTaskByIndex(userId: string, chatId: string, index: number) {
    const task = await this.resolveTaskFromContext(chatId, index);
    const user = await this.usersService.requireActiveUser(userId);
    this.assertCanDeleteTask(user, task);

    return this.prisma.task.delete({
      where: { id: task.id },
    });
  }

  async getEditableTaskByIndex(userId: string, chatId: string, index: number) {
    const task = await this.resolveTaskFromContext(chatId, index);
    const user = await this.usersService.requireActiveUser(userId);
    this.assertCanEditTask(user, task);
    return task;
  }

  async getVisibleTaskByIndex(userId: string, chatId: string, index: number) {
    const task = await this.resolveTaskFromContext(chatId, index);
    const user = await this.usersService.requireActiveUser(userId);
    this.assertCanViewTask(user, task);
    return task;
  }

  async getVisibleTaskById(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: taskActorInclude,
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    const user = await this.usersService.requireActiveUser(userId);
    this.assertCanViewTask(user, task);
    return task;
  }

  async getEditableTaskById(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: taskActorInclude,
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    const user = await this.usersService.requireActiveUser(userId);
    this.assertCanEditTask(user, task);
    return task;
  }

  async updateTaskDueDate(
    userId: string,
    taskId: string,
    dueDate: string | null,
  ) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanEditTask(user, task);

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        dueDate: dueDate ? new Date(dueDate) : null,
        reminderSent: false,
      },
      include: taskActorInclude,
    });
  }

  async updateTaskTitle(userId: string, taskId: string, title: string) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanEditTask(user, task);

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        title,
      },
      include: taskActorInclude,
    });
  }

  async updateTaskReminderMinutesBefore(
    userId: string,
    taskId: string,
    reminderMinutesBefore: number | null,
  ) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanEditTask(user, task);

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        reminderMinutesBefore,
        reminderSent: false,
      },
      include: taskActorInclude,
    });
  }

  async updateTaskScope(userId: string, taskId: string, scope: TaskScope) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanEditTask(user, task);

    const assignedToUserId =
      scope === TaskScope.PERSONAL ? user.id : task.assignedToUserId;

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        scope,
        assignedToUserId,
      },
      include: taskActorInclude,
    });
  }

  async updateTaskDescription(
    userId: string,
    taskId: string,
    description: string | null,
  ) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanEditTask(user, task);

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        description,
      },
      include: taskActorInclude,
    });
  }

  async updateTaskAssignee(
    userId: string,
    taskId: string,
    assignedToUserId: string | null,
  ) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanEditTask(user, task);

    if (task.scope !== TaskScope.FAMILY) {
      throw new BadRequestException(
        'Solo puedes asignar tareas familiares a miembros de la familia.',
      );
    }

    let resolvedAssigneeId: string | null = null;

    if (assignedToUserId) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: assignedToUserId },
      });

      if (!assignee || !assignee.isActive || assignee.familyId !== user.familyId) {
        throw new BadRequestException(
          'La persona seleccionada no pertenece a tu familia.',
        );
      }

      resolvedAssigneeId = assignee.id;
    }

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        assignedToUserId: resolvedAssigneeId,
      },
      include: taskActorInclude,
    });
  }

  async getTasksFromContext(chatId: string) {
    const taskIds = await this.getTaskIdsFromContext(chatId);
    if (taskIds.length === 0) {
      return [];
    }

    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
      include: taskActorInclude,
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is TaskWithActors => Boolean(task));
  }

  async completeTasksByIds(userId: string, taskIds: string[]) {
    const user = await this.usersService.requireActiveUser(userId);
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
    });

    if (tasks.length !== taskIds.length) {
      throw new BadRequestException('Algunas tareas ya no existen.');
    }

    tasks.forEach((task) => this.assertCanCompleteTask(user, task));

    await this.prisma.task.updateMany({
      where: { id: { in: taskIds } },
      data: {
        status: TaskStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    return tasks;
  }

  async completeTaskById(userId: string, taskId: string) {
    const user = await this.usersService.requireActiveUser(userId);
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    this.assertCanCompleteTask(user, task);

    return this.prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  }

  async deleteTasksByIds(userId: string, taskIds: string[]) {
    const user = await this.usersService.requireActiveUser(userId);
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
    });

    if (tasks.length !== taskIds.length) {
      throw new BadRequestException('Algunas tareas ya no existen.');
    }

    tasks.forEach((task) => this.assertCanDeleteTask(user, task));

    await this.prisma.task.deleteMany({
      where: { id: { in: taskIds } },
    });

    return tasks;
  }

  async getTasksDueForReminder(
    maxReminderMinutesBefore: number,
    overdueGraceMinutes = 0,
  ) {
    const now = DateTime.now();
    const lowerBound = now.minus({ minutes: overdueGraceMinutes }).toJSDate();
    const limit = now.plus({ minutes: maxReminderMinutesBefore }).toJSDate();

    return this.prisma.task.findMany({
      where: {
        status: TaskStatus.PENDING,
        dueDate: {
          gte: lowerBound,
          lte: limit,
        },
      },
      include: {
        family: {
          include: {
            settings: true,
            users: {
              where: {
                isActive: true,
                telegramChatId: { not: null },
              },
              select: {
                id: true,
                telegramChatId: true,
                isActive: true,
                reminderMinutesBefore: true,
              },
            },
          },
        },
        createdByUser: {
          select: {
            id: true,
            telegramChatId: true,
            isActive: true,
            reminderMinutesBefore: true,
          },
        },
        assignedToUser: {
          select: {
            id: true,
            telegramChatId: true,
            isActive: true,
            reminderMinutesBefore: true,
          },
        },
      },
    });
  }

  async getMaxReminderMinutesBefore(globalReminderMinutesBefore: number) {
    const [taskMax, userMax, familyMax] = await Promise.all([
      this.prisma.task.aggregate({
        _max: {
          reminderMinutesBefore: true,
        },
      }),
      this.prisma.user.aggregate({
        _max: {
          reminderMinutesBefore: true,
        },
      }),
      this.prisma.settings.aggregate({
        _max: {
          reminderMinutesBefore: true,
        },
      }),
    ]);

    return Math.max(
      globalReminderMinutesBefore,
      taskMax._max.reminderMinutesBefore ?? 0,
      userMax._max.reminderMinutesBefore ?? 0,
      familyMax._max.reminderMinutesBefore ?? 0,
    );
  }

  resolveReminderMinutesBeforeForRecipient(
    task: TaskWithReminderContext,
    recipient: ReminderTargetUser,
    globalReminderMinutesBefore: number,
  ) {
    if (task.reminderMinutesBefore != null) {
      return task.reminderMinutesBefore;
    }

    if (recipient.reminderMinutesBefore != null) {
      return recipient.reminderMinutesBefore;
    }

    if (task.family.settings?.reminderMinutesBefore != null) {
      return task.family.settings.reminderMinutesBefore;
    }

    return globalReminderMinutesBefore;
  }

  getReminderRecipientsForTask(task: TaskWithReminderContext) {
    const candidates =
      task.scope === TaskScope.FAMILY
        ? task.assignedToUserId
          ? [task.createdByUser, task.assignedToUser].filter(
              (user): user is ReminderTargetUser => Boolean(user),
            )
          : task.family.users
        : [task.assignedToUser ?? task.createdByUser].filter(
            (user): user is ReminderTargetUser => Boolean(user),
          );

    const seenUserIds = new Set<string>();

    return candidates.filter((user) => {
      if (!user.isActive || !user.telegramChatId || seenUserIds.has(user.id)) {
        return false;
      }

      seenUserIds.add(user.id);
      return true;
    });
  }

  async getReminderDelivery({
    taskId,
    userId,
    dueDateSnapshot,
    channel = 'TELEGRAM',
  }: ReminderDeliveryKey) {
    return this.reminderDeliveryDelegate.findUnique({
      where: {
        taskId_userId_dueDateSnapshot_channel: {
          taskId,
          userId,
          dueDateSnapshot,
          channel,
        },
      },
    });
  }

  async markReminderDelivered({
    taskId,
    userId,
    dueDateSnapshot,
    effectiveReminderMinutesBefore,
    scheduledFor,
    channel = 'TELEGRAM',
  }: ReminderDeliveryWrite) {
    const now = new Date();

    return this.reminderDeliveryDelegate.upsert({
      where: {
        taskId_userId_dueDateSnapshot_channel: {
          taskId,
          userId,
          dueDateSnapshot,
          channel,
        },
      },
      create: {
        taskId,
        userId,
        dueDateSnapshot,
        channel,
        effectiveReminderMinutesBefore,
        scheduledFor,
        attemptCount: 1,
        lastAttemptAt: now,
        sentAt: now,
        failedAt: null,
        errorMessage: null,
      },
      update: {
        effectiveReminderMinutesBefore,
        scheduledFor,
        attemptCount: {
          increment: 1,
        },
        lastAttemptAt: now,
        sentAt: now,
        failedAt: null,
        errorMessage: null,
      },
    });
  }

  async markReminderDeliveryFailed({
    taskId,
    userId,
    dueDateSnapshot,
    effectiveReminderMinutesBefore,
    scheduledFor,
    errorMessage,
    channel = 'TELEGRAM',
  }: ReminderDeliveryWrite) {
    const now = new Date();

    return this.reminderDeliveryDelegate.upsert({
      where: {
        taskId_userId_dueDateSnapshot_channel: {
          taskId,
          userId,
          dueDateSnapshot,
          channel,
        },
      },
      create: {
        taskId,
        userId,
        dueDateSnapshot,
        channel,
        effectiveReminderMinutesBefore,
        scheduledFor,
        attemptCount: 1,
        lastAttemptAt: now,
        failedAt: now,
        errorMessage: errorMessage ?? null,
      },
      update: {
        effectiveReminderMinutesBefore,
        scheduledFor,
        attemptCount: {
          increment: 1,
        },
        lastAttemptAt: now,
        failedAt: now,
        errorMessage: errorMessage ?? null,
      },
    });
  }

  async getDailyBriefingPayload(userId: string) {
    const user = await this.usersService.requireActiveUser(userId);
    const timezone = this.usersService.resolveTimezone(user);
    const now = DateTime.now().setZone(timezone);
    const pendingTasks = await this.listPendingTasks(userId);

    const overdue: DailyBriefingTask[] = [];
    const today: DailyBriefingTask[] = [];
    const upcoming: DailyBriefingTask[] = [];
    const withoutDueDate: DailyBriefingTask[] = [];

    pendingTasks.forEach((task) => {
      if (!task.dueDate) {
        withoutDueDate.push(task);
        return;
      }

      const due = DateTime.fromJSDate(task.dueDate).setZone(timezone);
      if (due < now) {
        overdue.push(task);
        return;
      }

      if (due.hasSame(now, 'day')) {
        today.push(task);
        return;
      }

      upcoming.push(task);
    });

    return {
      overdue,
      today,
      upcoming,
      withoutDueDate,
      totalPending: pendingTasks.length,
    };
  }

  private async resolveTaskFromContext(chatId: string, index: number) {
    if (!Number.isInteger(index) || index <= 0) {
      throw new BadRequestException(
        'El indice debe ser un numero mayor a cero.',
      );
    }

    const taskIds = await this.getTaskIdsFromContext(chatId);
    const taskId = taskIds[index - 1];

    if (!taskId) {
      throw new BadRequestException('Ese indice no existe en la lista actual.');
    }

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: taskActorInclude,
    });
    if (!task) {
      throw new BadRequestException('La tarea ya no existe.');
    }

    return task;
  }

  private async getTaskIdsFromContext(chatId: string) {
    const context = await this.prisma.chatContext.findUnique({
      where: { chatId },
    });

    if (!context) {
      throw new BadRequestException(
        'No hay una lista reciente. Usa /pendientes, /hoy o /familiares primero.',
      );
    }

    return JSON.parse(context.taskIdsJson) as string[];
  }

  private assertCanCompleteTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException(
        'No puedes completar tareas de otra familia.',
      );
    }

    if (task.scope === TaskScope.PERSONAL) {
      if (task.createdByUserId === user.id || task.assignedToUserId === user.id) {
        return;
      }

      throw new ForbiddenException(
        'Solo puedes completar tus tareas personales.',
      );
    }

    if (!task.assignedToUserId) {
      return;
    }

    if (
      user.role === UserRole.FAMILY_ADMIN ||
      task.createdByUserId === user.id ||
      task.assignedToUserId === user.id
    ) {
      return;
    }

    throw new ForbiddenException(
      'La tarea familiar esta asignada a otro usuario.',
    );
  }

  private assertCanDeleteTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException(
        'No puedes eliminar tareas de otra familia.',
      );
    }

    if (task.scope === TaskScope.FAMILY && user.role === UserRole.FAMILY_ADMIN) {
      return;
    }

    if (
      task.scope === TaskScope.PERSONAL &&
      (task.createdByUserId === user.id || task.assignedToUserId === user.id)
    ) {
      return;
    }

    throw new ForbiddenException(
      task.scope === TaskScope.FAMILY
        ? 'Solo un administrador familiar puede eliminar tareas familiares.'
        : 'Solo puedes eliminar tus tareas personales.',
    );
  }

  private assertCanEditTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException('No puedes editar tareas de otra familia.');
    }

    if (task.status !== TaskStatus.PENDING) {
      throw new BadRequestException('Solo puedes editar tareas pendientes.');
    }

    if (task.scope === TaskScope.PERSONAL) {
      if (task.createdByUserId === user.id || task.assignedToUserId === user.id) {
        return;
      }

      throw new ForbiddenException('Solo puedes editar tus tareas personales.');
    }

    if (!task.assignedToUserId) {
      return;
    }

    if (
      user.role === UserRole.FAMILY_ADMIN ||
      task.createdByUserId === user.id ||
      task.assignedToUserId === user.id
    ) {
      return;
    }

    throw new ForbiddenException(
      'La tarea familiar esta asignada a otro usuario.',
    );
  }

  private assertCanViewTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException('No puedes ver tareas de otra familia.');
    }

    if (task.scope === TaskScope.FAMILY) {
      return;
    }

    if (
      task.createdByUserId !== user.id &&
      task.assignedToUserId !== user.id
    ) {
      throw new ForbiddenException('Solo puedes ver tus tareas personales.');
    }
  }

  private visibilityWhere(user: User): Prisma.TaskWhereInput {
    return {
      OR: [
        { scope: TaskScope.FAMILY },
        { assignedToUserId: user.id },
        { createdByUserId: user.id },
      ],
    };
  }

  private async resolveAssignedUserId(
    user: ActiveUser,
    dto: CreateTaskDto,
  ): Promise<string | null> {
    if (dto.scope === TaskScope.PERSONAL) {
      return user.id;
    }

    if (!dto.assignedToUserId) {
      return null;
    }

    const assignee = await this.prisma.user.findUnique({
      where: { id: dto.assignedToUserId },
    });

    if (!assignee || !assignee.isActive || assignee.familyId !== user.familyId) {
      throw new BadRequestException(
        'La persona asignada no pertenece a tu familia.',
      );
    }

    return assignee.id;
  }
}

function normalizeTaskTitle(title: string) {
  return title
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ');
}
