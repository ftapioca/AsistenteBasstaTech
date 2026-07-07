import { DateTime } from 'luxon';
import { RemindersService } from './reminders.service';

describe('RemindersService', () => {
  function createService() {
    const tasksService = {
      getMaxReminderMinutesBefore: jest.fn().mockResolvedValue(30),
      getTasksDueForReminder: jest.fn(),
      resolveReminderMinutesBeforeForRecipient: jest.fn().mockReturnValue(30),
      getReminderRecipientsForTask: jest.fn(),
      getReminderDelivery: jest.fn().mockResolvedValue(null),
      markReminderDelivered: jest.fn().mockResolvedValue(undefined),
      markReminderDeliveryFailed: jest.fn().mockResolvedValue(undefined),
    };
    const telegramService = {
      sendTaskReminder: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string, fallback: number) => {
        if (key === 'REMINDER_MINUTES_BEFORE') {
          return 30;
        }

        if (key === 'REMINDER_OVERDUE_GRACE_MINUTES') {
          return 30;
        }

        return fallback;
      }),
    };

    return {
      tasksService,
      telegramService,
      service: new RemindersService(
        tasksService as never,
        telegramService as never,
        configService as never,
      ),
    };
  }

  it('envia recordatorios de tarea familiar sin asignar a todos los miembros', async () => {
    const { service, tasksService, telegramService } = createService();
    const task = {
      id: 'task-1',
      title: 'Comprar pan',
      reminderSent: false,
      dueDate: DateTime.now().toJSDate(),
    };

    tasksService.getTasksDueForReminder.mockResolvedValue([task]);
    tasksService.getReminderRecipientsForTask.mockReturnValue([
      { id: 'u1', telegramChatId: 'chat-1', isActive: true },
      { id: 'u2', telegramChatId: 'chat-2', isActive: true },
      { id: 'u3', telegramChatId: 'chat-3', isActive: true },
    ]);

    await service.processReminders();

    expect(telegramService.sendTaskReminder).toHaveBeenCalledTimes(3);
    expect(telegramService.sendTaskReminder).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      task.id,
      expect.any(String),
    );
    expect(telegramService.sendTaskReminder).toHaveBeenNthCalledWith(
      2,
      'chat-2',
      task.id,
      expect.any(String),
    );
    expect(telegramService.sendTaskReminder).toHaveBeenNthCalledWith(
      3,
      'chat-3',
      task.id,
      expect.any(String),
    );
    expect(tasksService.markReminderDelivered).toHaveBeenCalledTimes(3);
  });

  it('envia recordatorios de tarea familiar asignada al asignador y al asignado', async () => {
    const { service, tasksService, telegramService } = createService();
    const task = {
      id: 'task-2',
      title: 'Revisar alertas',
      reminderSent: false,
      dueDate: DateTime.now().toJSDate(),
    };

    tasksService.getTasksDueForReminder.mockResolvedValue([task]);
    tasksService.getReminderRecipientsForTask.mockReturnValue([
      { id: 'creator', telegramChatId: 'chat-creator', isActive: true },
      { id: 'assignee', telegramChatId: 'chat-assignee', isActive: true },
    ]);

    await service.processReminders();

    expect(telegramService.sendTaskReminder).toHaveBeenCalledTimes(2);
    expect(telegramService.sendTaskReminder).toHaveBeenCalledWith(
      'chat-creator',
      task.id,
      expect.any(String),
    );
    expect(telegramService.sendTaskReminder).toHaveBeenCalledWith(
      'chat-assignee',
      task.id,
      expect.any(String),
    );
    expect(tasksService.markReminderDelivered).toHaveBeenCalledTimes(2);
  });

  it('no reenvia si ya existe un delivery con sentAt para task + user + dueDate', async () => {
    const { service, tasksService, telegramService } = createService();
    const dueDate = DateTime.now().toJSDate();
    const task = {
      id: 'task-3',
      title: 'Pagar cuentas',
      reminderSent: false,
      dueDate,
    };

    tasksService.getTasksDueForReminder.mockResolvedValue([task]);
    tasksService.getReminderRecipientsForTask.mockReturnValue([
      { id: 'u1', telegramChatId: 'chat-1', isActive: true },
    ]);
    tasksService.getReminderDelivery.mockResolvedValue({
      sentAt: new Date(),
    });

    await service.processReminders();

    expect(telegramService.sendTaskReminder).not.toHaveBeenCalled();
    expect(tasksService.markReminderDelivered).not.toHaveBeenCalled();
  });

  it('rescata recordatorios dentro de la ventana de gracia', async () => {
    const { service, tasksService, telegramService } = createService();
    const task = {
      id: 'task-4',
      title: 'Sacar basura',
      reminderSent: false,
      dueDate: DateTime.now().minus({ minutes: 5 }).toJSDate(),
    };

    tasksService.getTasksDueForReminder.mockResolvedValue([task]);
    tasksService.getReminderRecipientsForTask.mockReturnValue([
      { id: 'u1', telegramChatId: 'chat-1', isActive: true },
    ]);
    tasksService.resolveReminderMinutesBeforeForRecipient.mockReturnValue(10);

    await service.processReminders();

    expect(telegramService.sendTaskReminder).toHaveBeenCalledTimes(1);
    expect(tasksService.markReminderDelivered).toHaveBeenCalledTimes(1);
  });

  it('hace retry inmediato una vez ante un fallo transitorio', async () => {
    const { service, tasksService, telegramService } = createService();
    const task = {
      id: 'task-5',
      title: 'Revisar panel',
      reminderSent: false,
      dueDate: DateTime.now().toJSDate(),
    };

    tasksService.getTasksDueForReminder.mockResolvedValue([task]);
    tasksService.getReminderRecipientsForTask.mockReturnValue([
      { id: 'u1', telegramChatId: 'chat-1', isActive: true },
    ]);
    telegramService.sendTaskReminder
      .mockRejectedValueOnce(new Error('Telegram 503 temporarily unavailable'))
      .mockResolvedValueOnce(undefined);

    await service.processReminders();

    expect(telegramService.sendTaskReminder).toHaveBeenCalledTimes(2);
    expect(tasksService.markReminderDelivered).toHaveBeenCalledTimes(1);
    expect(tasksService.markReminderDeliveryFailed).not.toHaveBeenCalled();
  });

  it('registra una falla y deja el delivery listo para retry posterior cuando el error persiste', async () => {
    const { service, tasksService, telegramService } = createService();
    const task = {
      id: 'task-6',
      title: 'Revisar panel',
      reminderSent: false,
      dueDate: DateTime.now().toJSDate(),
    };

    tasksService.getTasksDueForReminder.mockResolvedValue([task]);
    tasksService.getReminderRecipientsForTask.mockReturnValue([
      { id: 'u1', telegramChatId: 'chat-1', isActive: true },
    ]);
    telegramService.sendTaskReminder.mockRejectedValue(
      new Error('Telegram 503 temporarily unavailable'),
    );

    await service.processReminders();

    expect(telegramService.sendTaskReminder).toHaveBeenCalledTimes(2);
    expect(tasksService.markReminderDelivered).not.toHaveBeenCalled();
    expect(tasksService.markReminderDeliveryFailed).toHaveBeenCalledTimes(1);
  });
});
