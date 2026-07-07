import { DateTime } from 'luxon';
import { RemindersService } from './reminders.service';

describe('RemindersService', () => {
  function createService() {
    const tasksService = {
      getMaxReminderMinutesBefore: jest.fn().mockResolvedValue(30),
      getTasksDueForReminder: jest.fn(),
      resolveReminderMinutesBeforeForTask: jest.fn().mockReturnValue(30),
      getReminderRecipientsForTask: jest.fn(),
      markReminderSent: jest.fn().mockResolvedValue(undefined),
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
    expect(tasksService.markReminderSent).toHaveBeenCalledWith(task.id);
  });

  it('envia recordatorios de tarea familiar asignada al asignador y al asignado', async () => {
    const { service, tasksService, telegramService } = createService();
    const task = {
      id: 'task-2',
      title: 'Revisar alertas',
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
    expect(tasksService.markReminderSent).toHaveBeenCalledWith(task.id);
  });
});
