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
    const globalReminderMinutesBefore = this.configService.get<number>(
      'REMINDER_MINUTES_BEFORE',
      30,
    );
    const overdueGraceMinutes = this.configService.get<number>(
      'REMINDER_OVERDUE_GRACE_MINUTES',
      30,
    );
    const maxReminderMinutesBefore =
      await this.tasksService.getMaxReminderMinutesBefore(
        globalReminderMinutesBefore,
      );
    const tasks = await this.tasksService.getTasksDueForReminder(
      maxReminderMinutesBefore,
      overdueGraceMinutes,
    );
    const now = DateTime.now();
    let sentCount = 0;

    for (const task of tasks) {
      if (!task.assignedToUser?.telegramChatId) {
        continue;
      }

      const reminderMinutesBefore =
        this.tasksService.resolveReminderMinutesBeforeForTask(
          task,
          globalReminderMinutesBefore,
        );
      if (reminderMinutesBefore === 0 || !task.dueDate) {
        continue;
      }

      const dueDate = task.dueDate ? DateTime.fromJSDate(task.dueDate) : null;
      const diffMinutes = dueDate
        ? Math.round(dueDate.diff(now, 'minutes').minutes)
        : null;
      if (
        diffMinutes == null ||
        diffMinutes > reminderMinutesBefore ||
        diffMinutes < -overdueGraceMinutes
      ) {
        continue;
      }

      const message = buildReminderMessage(
        task.title,
        dueDate,
        now,
        reminderMinutesBefore,
      );

      await this.telegramService.sendTaskReminder(
        task.assignedToUser.telegramChatId,
        task.id,
        message,
      );
      await this.tasksService.markReminderSent(task.id);
      sentCount += 1;
    }

    if (sentCount > 0) {
      this.logger.log(`Recordatorios enviados: ${sentCount}`);
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
