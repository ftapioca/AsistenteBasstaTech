import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/modules/database/prisma.service';

describe('HealthController (e2e)', () => {
  let app: INestApplication;
  const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = '';
    process.env.OPENAI_API_KEY = '';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    return request(server).get('/').expect(200).expect({
      service: 'Bot Asistente Familiar',
      status: 'ok',
    });
  });

  afterEach(async () => {
    await app.get(PrismaService).$disconnect();
    await app.close();
    process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  });
});
