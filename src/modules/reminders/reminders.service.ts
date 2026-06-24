import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
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
    const tasks = await this.tasksService.getTasksDueForReminder(
      reminderMinutesBefore,
    );

    for (const task of tasks) {
      if (!task.assignedToUser?.telegramChatId) {
        continue;
      }

      await this.telegramService.sendText(
        task.assignedToUser.telegramChatId,
        `⏰ Recordatorio\n\nEn ${reminderMinutesBefore} minutos vence:\n\n${task.title}`,
      );
      await this.tasksService.markReminderSent(task.id);
    }

    if (tasks.length > 0) {
      this.logger.log(`Recordatorios enviados: ${tasks.length}`);
    }
  }
}
