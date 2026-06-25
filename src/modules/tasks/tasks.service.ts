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
type PendingAction = {
  type: 'CREATE_TASK_CONFIRMATION';
  reason: 'AMBIGUOUS_DATE' | 'DUPLICATE_TASK';
  dto: CreateTaskDto;
  duplicateTaskTitle?: string;
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

        if ((task.dueDate === null) !== (dueDate === null)) {
          return false;
        }

        if (!task.dueDate && !dueDate) {
          return true;
        }

        return (
          task.dueDate !== null &&
          dueDate !== null &&
          Math.abs(task.dueDate.getTime() - dueDate.getTime()) < 60_000
        );
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

  async getTasksDueForReminder(reminderMinutesBefore: number) {
    const now = new Date();
    const limit = DateTime.now()
      .plus({ minutes: reminderMinutesBefore })
      .toJSDate();

    return this.prisma.task.findMany({
      where: {
        status: TaskStatus.PENDING,
        reminderSent: false,
        dueDate: {
          gte: now,
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

    const context = await this.prisma.chatContext.findUnique({
      where: { chatId },
    });

    if (!context) {
      throw new BadRequestException(
        'No hay una lista reciente. Usa /pendientes, /hoy o /familiares primero.',
      );
    }

    const taskIds = JSON.parse(context.taskIdsJson) as string[];
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
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}
