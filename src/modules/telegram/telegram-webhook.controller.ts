import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import type { Update } from 'telegraf/types';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() update: Update,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ) {
    await this.telegramService.handleWebhookUpdate(update, secretToken);
    return { ok: true };
  }
}
