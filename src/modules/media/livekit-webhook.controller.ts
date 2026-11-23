import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators/public.decorator.js';
import { MediaService } from './media.service.js';
import { headerValue, readRawBody } from './raw-body.js';

@ApiTags('media')
@Controller('media/livekit')
export class LivekitWebhookController {
  constructor(private readonly mediaService: MediaService) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Webhook LiveKit Server',
    description:
      'Принимает participant_joined, participant_left, participant_connection_aborted и room_finished. Тело читается как есть и проверяется подписью LiveKit. Событие не создаёт конференцию, не завершает её и не закрывает WebSocket, если сокет ещё подключён. Повторная доставка безопасна.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { received: { type: 'boolean', example: true } },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Нет заголовка Authorization или подпись не совпала',
  })
  async receive(
    @Req() request: FastifyRequest,
    @Headers('authorization') authorization?: string | string[],
    @Headers('authorize') authorize?: string | string[],
  ): Promise<{ received: true }> {
    const rawBody = readRawBody(request);

    if (!rawBody) {
      throw new UnauthorizedException('Недействительная подпись webhook');
    }

    await this.mediaService.handleWebhook(
      rawBody,
      headerValue(authorization) ?? headerValue(authorize),
    );

    return { received: true };
  }
}
