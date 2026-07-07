import {
  Priority,
  TaskScope,
  TaskStatus,
  UserRole,
  type Task,
  type User,
} from '@prisma/client';
import { TasksService } from './tasks.service';

type MockPrisma = {
  task: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  taskReminderDelivery: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
};

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    familyId: 'family-1',
    name: 'User One',
    phoneNumber: '+56911111111',
    telegramUserId: 'tg-1',
    telegramChatId: 'chat-1',
    telegramUsername: 'userone',
    role: UserRole.USER,
    reminderMinutesBefore: null,
    timezone: 'America/Santiago',
    dailyBriefingTime: null,
    isActive: true,
    createdAt: new Date('2026-07-07T12:00:00.000Z'),
    updatedAt: new Date('2026-07-07T12:00:00.000Z'),
    ...overrides,
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    familyId: 'family-1',
    createdByUserId: 'user-1',
    assignedToUserId: 'user-1',
    title: 'Revisar alertas',
    description: null,
    status: TaskStatus.PENDING,
    priority: Priority.MEDIUM,
    scope: TaskScope.PERSONAL,
    dueDate: null,
    reminderMinutesBefore: null,
    reminderSent: false,
    completedAt: null,
    createdAt: new Date('2026-07-07T12:00:00.000Z'),
    updatedAt: new Date('2026-07-07T12:00:00.000Z'),
    ...overrides,
  };
}

function createService() {
  const prisma: MockPrisma = {
    task: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    taskReminderDelivery: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const usersService = {
    requireActiveUser: jest.fn(),
    resolveTimezone: jest.fn().mockReturnValue('America/Santiago'),
  };

  return {
    prisma,
    usersService,
    service: new TasksService(prisma as never, usersService as never),
  };
}

describe('TasksService permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('oculta tareas personales ajenas incluso para admins', async () => {
    const { service, prisma, usersService } = createService();
    const admin = buildUser({ id: 'admin-1', role: UserRole.FAMILY_ADMIN });
    const otherPersonalTask = buildTask({
      createdByUserId: 'user-2',
      assignedToUserId: 'user-2',
      scope: TaskScope.PERSONAL,
    });

    usersService.requireActiveUser.mockResolvedValue(admin);
    prisma.task.findUnique.mockResolvedValue(otherPersonalTask);

    await expect(
      service.getVisibleTaskById(admin.id, otherPersonalTask.id),
    ).rejects.toThrow('Solo puedes ver tus tareas personales.');
  });

  it('permite ver tareas familiares asignadas a cualquier integrante de la familia', async () => {
    const { service, prisma, usersService } = createService();
    const familyUser = buildUser({ id: 'user-3', role: UserRole.USER });
    const assignedFamilyTask = buildTask({
      scope: TaskScope.FAMILY,
      createdByUserId: 'user-1',
      assignedToUserId: 'user-2',
    });

    usersService.requireActiveUser.mockResolvedValue(familyUser);
    prisma.task.findUnique.mockResolvedValue(assignedFamilyTask);

    await expect(
      service.getVisibleTaskById(familyUser.id, assignedFamilyTask.id),
    ).resolves.toBe(assignedFamilyTask);
  });

  it('permite editar una tarea familiar sin asignar a cualquier integrante', async () => {
    const { service, prisma, usersService } = createService();
    const familyUser = buildUser({ id: 'user-3' });
    const unassignedFamilyTask = buildTask({
      scope: TaskScope.FAMILY,
      createdByUserId: 'user-2',
      assignedToUserId: null,
    });
    const updatedTask = {
      ...unassignedFamilyTask,
      title: 'Nuevo titulo',
    };

    usersService.requireActiveUser.mockResolvedValue(familyUser);
    prisma.task.findUnique.mockResolvedValue(unassignedFamilyTask);
    prisma.task.update.mockResolvedValue(updatedTask);

    await expect(
      service.updateTaskTitle(familyUser.id, unassignedFamilyTask.id, 'Nuevo titulo'),
    ).resolves.toBe(updatedTask);
  });

  it('bloquea editar una tarea familiar asignada a un tercero cuando no eres admin, creador ni asignado', async () => {
    const { service, prisma, usersService } = createService();
    const unrelatedUser = buildUser({ id: 'user-4', role: UserRole.USER });
    const assignedFamilyTask = buildTask({
      scope: TaskScope.FAMILY,
      createdByUserId: 'user-1',
      assignedToUserId: 'user-2',
    });

    usersService.requireActiveUser.mockResolvedValue(unrelatedUser);
    prisma.task.findUnique.mockResolvedValue(assignedFamilyTask);

    await expect(
      service.updateTaskTitle(unrelatedUser.id, assignedFamilyTask.id, 'Nuevo titulo'),
    ).rejects.toThrow('La tarea familiar esta asignada a otro usuario.');
  });

  it('restringe eliminar tareas familiares solo a admins', async () => {
    const { service, prisma, usersService } = createService();
    const familyUser = buildUser({ id: 'user-2', role: UserRole.USER });
    const familyTask = buildTask({
      scope: TaskScope.FAMILY,
      assignedToUserId: null,
    });

    usersService.requireActiveUser.mockResolvedValue(familyUser);
    prisma.task.findMany.mockResolvedValue([familyTask]);

    await expect(
      service.deleteTasksByIds(familyUser.id, [familyTask.id]),
    ).rejects.toThrow('Solo un administrador familiar puede eliminar tareas familiares.');
  });

  it('asigna al actor cuando convierte una tarea a personal', async () => {
    const { service, prisma, usersService } = createService();
    const actor = buildUser({ id: 'user-9' });
    const familyTask = buildTask({
      scope: TaskScope.FAMILY,
      createdByUserId: 'user-9',
      assignedToUserId: 'user-2',
    });

    usersService.requireActiveUser.mockResolvedValue(actor);
    prisma.task.findUnique.mockResolvedValue(familyTask);
    prisma.task.update.mockImplementation(async (args) => ({
      ...familyTask,
      ...args.data,
    }));

    const updatedTask = await service.updateTaskScope(
      actor.id,
      familyTask.id,
      TaskScope.PERSONAL,
    );

    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: TaskScope.PERSONAL,
          assignedToUserId: actor.id,
        }),
      }),
    );
    expect(updatedTask.assignedToUserId).toBe(actor.id);
  });

  it('filtra listas para no mostrar tareas personales de otros integrantes', async () => {
    const { service, prisma, usersService } = createService();
    const admin = buildUser({ id: 'admin-1', role: UserRole.FAMILY_ADMIN });

    usersService.requireActiveUser.mockResolvedValue(admin);
    prisma.task.findMany.mockResolvedValue([]);

    await service.listPendingTasks(admin.id);

    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          familyId: admin.familyId,
          status: TaskStatus.PENDING,
          OR: [
            { scope: TaskScope.FAMILY },
            { assignedToUserId: admin.id },
            { createdByUserId: admin.id },
          ],
        }),
      }),
    );
  });

  it('usa la preferencia del destinatario para calcular recordatorios por usuario', () => {
    const { service } = createService();
    const task = {
      ...buildTask({
        scope: TaskScope.FAMILY,
        reminderMinutesBefore: null,
      }),
      createdByUser: {
        id: 'user-1',
        telegramChatId: 'chat-1',
        isActive: true,
        reminderMinutesBefore: null,
      },
      assignedToUser: {
        id: 'user-2',
        telegramChatId: 'chat-2',
        isActive: true,
        reminderMinutesBefore: 10,
      },
      family: {
        settings: {
          id: 'settings-1',
          familyId: 'family-1',
          reminderMinutesBefore: 30,
          timezone: 'America/Santiago',
          dailyBriefingTime: '08:30',
        },
        users: [],
      },
    };

    expect(
      service.resolveReminderMinutesBeforeForRecipient(
        task,
        task.assignedToUser,
        45,
      ),
    ).toBe(10);
  });

  it('devuelve a toda la familia para tareas familiares sin asignar y evita duplicados', () => {
    const { service } = createService();
    const familyUser = {
      id: 'user-2',
      telegramChatId: 'chat-2',
      isActive: true,
      reminderMinutesBefore: null,
    };
    const task = {
      ...buildTask({
        scope: TaskScope.FAMILY,
        assignedToUserId: null,
      }),
      createdByUser: {
        id: 'user-1',
        telegramChatId: 'chat-1',
        isActive: true,
        reminderMinutesBefore: null,
      },
      assignedToUser: null,
      family: {
        settings: null,
        users: [
          {
            id: 'user-1',
            telegramChatId: 'chat-1',
            isActive: true,
            reminderMinutesBefore: null,
          },
          familyUser,
          familyUser,
        ],
      },
    };

    expect(service.getReminderRecipientsForTask(task)).toEqual([
      {
        id: 'user-1',
        telegramChatId: 'chat-1',
        isActive: true,
        reminderMinutesBefore: null,
      },
      familyUser,
    ]);
  });
});
