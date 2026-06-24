import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { TelegramModule } from '../telegram/telegram.module';
import { RemindersService } from './reminders.service';

@Module({
  imports: [TasksModule, TelegramModule],
  providers: [RemindersService],
})
export class RemindersModule {}
