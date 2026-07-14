import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { bootstrapEnvironment } from './config/env.bootstrap';
import { validateEnvironment } from './config/env.validation';
import { AiModule } from './modules/ai/ai.module';
import { DailyBriefingModule } from './modules/daily-briefing/daily-briefing.module';
import { DatabaseModule } from './modules/database/database.module';
import { FamiliesModule } from './modules/families/families.module';
import { HealthModule } from './modules/health/health.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { UsersModule } from './modules/users/users.module';

bootstrapEnvironment();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateEnvironment,
      expandVariables: false,
      cache: true,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    HealthModule,
    FamiliesModule,
    UsersModule,
    TasksModule,
    AiModule,
    TelegramModule,
    RemindersModule,
    DailyBriefingModule,
  ],
})
export class AppModule {}
