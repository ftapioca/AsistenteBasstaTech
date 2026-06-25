import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { TasksService } from '../tasks/tasks.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly tasksService: TasksService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('* * * * *')
  async processReminders() {
    const reminderMinutesBefore = this.configService.get<number>(
      'REMINDER_MINUTES_BEFORE',
      30,
    );
    const overdueGraceMinutes = this.configService.get<number>(
      'REMINDER_OVERDUE_GRACE_MINUTES',
      30,
    );
    const tasks = await this.tasksService.getTasksDueForReminder(
      reminderMinutesBefore,
      overdueGraceMinutes,
    );
    const now = DateTime.now();

    for (const task of tasks) {
      if (!task.assignedToUser?.telegramChatId) {
        continue;
      }

      const dueDate = task.dueDate ? DateTime.fromJSDate(task.dueDate) : null;
      const message = buildReminderMessage(
        task.title,
        dueDate,
        now,
        reminderMinutesBefore,
      );

      await this.telegramService.sendText(
        task.assignedToUser.telegramChatId,
        message,
      );
      await this.tasksService.markReminderSent(task.id);
    }

    if (tasks.length > 0) {
      this.logger.log(`Recordatorios enviados: ${tasks.length}`);
    }
  }
}

function buildReminderMessage(
  title: string,
  dueDate: DateTime | null,
  now: DateTime,
  reminderMinutesBefore: number,
) {
  if (!dueDate) {
    return `⏰ Recordatorio\n\nTienes pendiente:\n\n${title}`;
  }

  const diffMinutes = Math.round(dueDate.diff(now, 'minutes').minutes);
  if (diffMinutes < 0) {
    const elapsedMinutes = Math.abs(diffMinutes);
    return `⏰ Recordatorio\n\nLa tarea ya vencio hace ${elapsedMinutes} minutos:\n\n${title}`;
  }

  if (diffMinutes === 0) {
    return `⏰ Recordatorio\n\nLa tarea vence ahora:\n\n${title}`;
  }

  if (diffMinutes !== reminderMinutesBefore) {
    return `⏰ Recordatorio\n\nLa tarea vence en ${diffMinutes} minutos:\n\n${title}`;
  }

  return `⏰ Recordatorio\n\nEn ${reminderMinutesBefore} minutos vence:\n\n${title}`;
}
