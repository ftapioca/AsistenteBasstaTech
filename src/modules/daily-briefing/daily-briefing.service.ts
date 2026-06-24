import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TaskScope } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { TelegramService } from '../telegram/telegram.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class DailyBriefingService {
  private readonly logger = new Logger(DailyBriefingService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly tasksService: TasksService,
    private readonly telegramService: TelegramService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('* * * * *')
  async processDailyBriefings() {
    const users = await this.usersService.getUsersEligibleForBriefing();

    for (const user of users) {
      if (!this.usersService.isBriefingDueNow(user)) {
        continue;
      }

      const date = this.usersService.getLocalDate(user);
      const existingLog = await this.prisma.dailyBriefingLog.findUnique({
        where: {
          userId_date: {
            userId: user.id,
            date,
          },
        },
      });

      if (existingLog) {
        continue;
      }

      const payload = await this.tasksService.getDailyBriefingPayload(user.id);
      const lines = [
        `Buenos dias ${user.name} ☀️`,
        '',
        'Estas son tus tareas para hoy:',
        '',
        'Personales:',
        ...formatTaskSection(payload.personal),
        '',
        'Familiares:',
        ...formatTaskSection(payload.family),
        '',
        `Tienes ${payload.personal.length + payload.family.length} tareas para hoy.`,
      ];

      await this.telegramService.sendText(
        user.telegramChatId!,
        lines.join('\n'),
      );
      await this.prisma.dailyBriefingLog.create({
        data: {
          userId: user.id,
          date,
        },
      });
      this.logger.log(`Briefing enviado a ${user.name}`);
    }
  }
}

function formatTaskSection(tasks: { title: string; scope: TaskScope }[]) {
  if (tasks.length === 0) {
    return ['Sin tareas.'];
  }

  return tasks.map((task, index) => `${index + 1}. ${task.title}`);
}
