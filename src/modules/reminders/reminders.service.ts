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
    const schedulerEnabled = this.configService.get<boolean | string>(
      'SCHEDULER_ENABLED',
      true,
    );
    if (schedulerEnabled === false || schedulerEnabled === 'false') {
      return;
    }

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
      if (!task.dueDate) {
        continue;
      }

      const recipients = this.tasksService.getReminderRecipientsForTask(task);
      if (recipients.length === 0) {
        continue;
      }

      const dueDate = DateTime.fromJSDate(task.dueDate);

      for (const recipient of recipients) {
        const reminderMinutesBefore =
          this.tasksService.resolveReminderMinutesBeforeForRecipient(
            task,
            recipient,
            globalReminderMinutesBefore,
          );
        if (reminderMinutesBefore === 0) {
          continue;
        }

        const diffMinutes = Math.round(dueDate.diff(now, 'minutes').minutes);
        if (
          diffMinutes > reminderMinutesBefore ||
          diffMinutes < -overdueGraceMinutes
        ) {
          continue;
        }

        const delivery = await this.tasksService.getReminderDelivery({
          taskId: task.id,
          userId: recipient.id,
          dueDateSnapshot: task.dueDate,
        });
        if (delivery?.sentAt) {
          continue;
        }

        const scheduledFor = dueDate
          .minus({ minutes: reminderMinutesBefore })
          .toJSDate();
        const message = buildReminderMessage(
          task.title,
          dueDate,
          now,
          reminderMinutesBefore,
        );

        try {
          await this.sendReminderWithRetry(
            recipient.telegramChatId as string,
            task.id,
            message,
          );
          await this.tasksService.markReminderDelivered({
            taskId: task.id,
            userId: recipient.id,
            dueDateSnapshot: task.dueDate,
            effectiveReminderMinutesBefore: reminderMinutesBefore,
            scheduledFor,
          });
          sentCount += 1;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Error desconocido';
          await this.tasksService.markReminderDeliveryFailed({
            taskId: task.id,
            userId: recipient.id,
            dueDateSnapshot: task.dueDate,
            effectiveReminderMinutesBefore: reminderMinutesBefore,
            scheduledFor,
            errorMessage,
          });
          this.logger.warn(
            `No se pudo enviar recordatorio de ${task.id} a ${recipient.id}: ${errorMessage}`,
          );
        }
      }
    }

    if (sentCount > 0) {
      this.logger.log(`Recordatorios enviados: ${sentCount}`);
    }
  }

  private async sendReminderWithRetry(
    chatId: string,
    taskId: string,
    message: string,
  ) {
    try {
      await this.telegramService.sendTaskReminder(chatId, taskId, message);
      return;
    } catch (error) {
      if (!this.isTransientReminderError(error)) {
        throw error;
      }
    }

    await this.telegramService.sendTaskReminder(chatId, taskId, message);
  }

  private isTransientReminderError(error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    return [
      '429',
      '500',
      '502',
      '503',
      '504',
      'timeout',
      'timed out',
      'network',
      'econnreset',
      'etimedout',
      'socket hang up',
      'temporarily unavailable',
    ].some((fragment) => message.includes(fragment));
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
