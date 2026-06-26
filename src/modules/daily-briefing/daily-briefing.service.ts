import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Priority, TaskScope } from '@prisma/client';
import { DateTime } from 'luxon';
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
      const timezone = this.usersService.resolveTimezone(user);
      const now = DateTime.now().setZone(timezone);
      const lines = [
        `Buenos dias ${user.name} ☀️`,
        '',
        'Este es tu resumen de pendientes:',
        '',
        ...formatTaskSection('🗓️ Hoy', payload.today, timezone, now),
        '',
        ...formatTaskSection('🚨 Vencidas', payload.overdue, timezone, now),
        '',
        ...formatTaskSection('📌 Proximas', payload.upcoming, timezone, now),
        '',
        ...formatTaskSection('📝 Sin fecha', payload.withoutDueDate, timezone, now),
        '',
        `Tienes ${payload.totalPending} tareas pendientes en total.`,
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

function formatTaskSection(
  title: string,
  tasks: {
    title: string;
    scope: TaskScope;
    dueDate: Date | null;
    priority: Priority;
    description: string | null;
  }[],
  timezone: string,
  now: DateTime,
) {
  const lines = [title];

  if (tasks.length === 0) {
    lines.push('Sin tareas.');
    return lines;
  }

  lines.push(
    ...tasks.map(
      (task, index) =>
        `${index + 1}. ${formatBriefingTaskLine(task, timezone, now)}`,
    ),
  );

  return lines;
}

function formatBriefingTaskLine(
  task: {
    title: string;
    scope: TaskScope;
    dueDate: Date | null;
    priority: Priority;
    description: string | null;
  },
  timezone: string,
  now: DateTime,
) {
  const parts = [task.scope === TaskScope.FAMILY ? '👪' : '👤'];

  if (task.priority === Priority.HIGH) {
    parts.push('‼️');
  } else if (task.priority === Priority.MEDIUM) {
    parts.push('❕');
  }

  if (task.description?.trim()) {
    parts.push('📝');
  }

  parts.push(task.title);

  if (!task.dueDate) {
    return parts.join(' ');
  }

  const due = DateTime.fromJSDate(task.dueDate).setZone(timezone);
  if (due < now) {
    const diffMinutes = Math.max(1, Math.round(now.diff(due, 'minutes').minutes));
    const label =
      diffMinutes < 60
        ? `${diffMinutes} min`
        : `${Math.floor(diffMinutes / 60)} h`;
    return `${parts.join(' ')} · vencida hace ${label}`;
  }

  if (due.hasSame(now, 'day')) {
    return `${parts.join(' ')} · a las ${due.toFormat('HH:mm')}`;
  }

  return `${parts.join(' ')} · ${due.toFormat('dd/MM HH:mm')}`;
}
