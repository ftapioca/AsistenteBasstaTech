import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersModule } from '../users/users.module';
import { DailyBriefingService } from './daily-briefing.service';

@Module({
  imports: [UsersModule, TasksModule, TelegramModule],
  providers: [DailyBriefingService],
})
export class DailyBriefingModule {}
