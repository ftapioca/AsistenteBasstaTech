import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  Priority,
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
type PendingAction =
  | {
      type: 'CREATE_TASK_CONFIRMATION';
      reason: 'AMBIGUOUS_DATE' | 'DUPLICATE_TASK';
      dto: CreateTaskDto;
      duplicateTaskTitle?: string;
    }
  | {
      type: 'CREATE_TASK_WIZARD';
      step: 'TITLE' | 'SCOPE' | 'DUE_DATE' | 'PRIORITY' | 'CONFIRM';
      draft: {
        title?: string;
        scope?: TaskScope;
        dueDate?: string | null;
        dueDateInput?: string | null;
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
      type: 'EDIT_TASK_WIZARD';
      step: 'DUE_DATE' | 'CONFIRM';
      taskId: string;
      draft: {
        dueDate?: string | null;
        dueDateInput?: string | null;
      };
    }
  | {
      type: 'TASK_NOTE_WIZARD';
      taskId: string;
    };

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async createTaskForUser(userId: string, dto: CreateTaskDto) {
    const user = await this.usersService.requireActiveUser(userId);

    return this.prisma.task.create({
      data: {
        familyId: user.familyId,
        createdByUserId: user.id,
        assignedToUserId: user.id,
        title: dto.title,
        description: dto.description ?? null,
        priority: dto.priority ?? Priority.MEDIUM,
        scope: dto.scope,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      },
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

  async updateTaskDueDate(userId: string, taskId: string, dueDate: string | null) {
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
    });
  }

  async getTasksFromContext(chatId: string) {
    const taskIds = await this.getTaskIdsFromContext(chatId);
    if (taskIds.length === 0) {
      return [];
    }

    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is Task => Boolean(task));
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
    reminderMinutesBefore: number,
    overdueGraceMinutes = 0,
  ) {
    const now = DateTime.now();
    const lowerBound = now.minus({ minutes: overdueGraceMinutes }).toJSDate();
    const limit = now
      .plus({ minutes: reminderMinutesBefore })
      .toJSDate();

    return this.prisma.task.findMany({
      where: {
        status: TaskStatus.PENDING,
        reminderSent: false,
        dueDate: {
          gte: lowerBound,
          lte: limit,
        },
      },
      include: {
        assignedToUser: true,
      },
    });
  }

  async markReminderSent(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: {
        reminderSent: true,
      },
    });
  }

  async getDailyBriefingPayload(userId: string) {
    const today = await this.listTodayTasks(userId);

    return {
      personal: today.filter((task) => task.scope === TaskScope.PERSONAL),
      family: today.filter((task) => task.scope === TaskScope.FAMILY),
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

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
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

    if (user.role === UserRole.FAMILY_ADMIN) {
      return;
    }

    if (
      task.scope === TaskScope.PERSONAL &&
      task.assignedToUserId !== user.id
    ) {
      throw new ForbiddenException(
        'Solo puedes completar tus tareas personales.',
      );
    }

    if (
      task.scope === TaskScope.FAMILY &&
      task.assignedToUserId &&
      task.assignedToUserId !== user.id
    ) {
      throw new ForbiddenException(
        'La tarea familiar esta asignada a otro usuario.',
      );
    }
  }

  private assertCanDeleteTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException(
        'No puedes eliminar tareas de otra familia.',
      );
    }

    if (user.role === UserRole.FAMILY_ADMIN) {
      return;
    }

    if (task.createdByUserId !== user.id && task.assignedToUserId !== user.id) {
      throw new ForbiddenException('Solo puedes eliminar tus propias tareas.');
    }
  }

  private assertCanEditTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException(
        'No puedes editar tareas de otra familia.',
      );
    }

    if (task.status !== TaskStatus.PENDING) {
      throw new BadRequestException(
        'Solo puedes editar tareas pendientes.',
      );
    }

    if (user.role === UserRole.FAMILY_ADMIN) {
      return;
    }

    if (task.scope === TaskScope.FAMILY) {
      if (task.createdByUserId === user.id || task.assignedToUserId === user.id) {
        return;
      }

      throw new ForbiddenException(
        'Solo puedes editar tareas familiares creadas por ti o asignadas a ti.',
      );
    }

    if (task.createdByUserId !== user.id && task.assignedToUserId !== user.id) {
      throw new ForbiddenException('Solo puedes editar tus propias tareas.');
    }
  }

  private assertCanViewTask(user: ActiveUser, task: Task) {
    if (task.familyId !== user.familyId) {
      throw new ForbiddenException(
        'No puedes ver tareas de otra familia.',
      );
    }

    if (user.role === UserRole.FAMILY_ADMIN) {
      return;
    }

    if (
      task.scope === TaskScope.PERSONAL &&
      task.createdByUserId !== user.id &&
      task.assignedToUserId !== user.id
    ) {
      throw new ForbiddenException('Solo puedes ver tus tareas personales.');
    }
  }

  private visibilityWhere(user: User): Prisma.TaskWhereInput {
    if (user.role === UserRole.FAMILY_ADMIN) {
      return {};
    }

    return {
      OR: [
        { scope: TaskScope.FAMILY },
        { assignedToUserId: user.id },
        { createdByUserId: user.id },
      ],
    };
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
