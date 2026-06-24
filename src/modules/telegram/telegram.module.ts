import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsersModule } from '../users/users.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AiModule, UsersModule, TasksModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
