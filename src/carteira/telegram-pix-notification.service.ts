import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecargaCarteira } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TelegramPixNotificationService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async enviar(recarga: RecargaCarteira): Promise<void> {
    const request = await this.prisma.telegramWalletRequest.findUnique({
      where: { recargaId: recarga.id },
      select: {
        telegramUserId: true, confirmadoEm: true,
        usuario: { select: { status: true, carteira: { select: { id: true } }, telegramLink: { select: { telegramUserId: true } } } },
      },
    });
    if (!request?.confirmadoEm || request.usuario.status !== 'ATIVO' ||
      request.usuario.carteira?.id !== recarga.carteiraId ||
      request.usuario.telegramLink?.telegramUserId !== request.telegramUserId ||
      !/^[1-9]\d{0,31}$/.test(request.telegramUserId)) return;

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
    if (!token) throw new Error('Telegram bot unavailable');
    const text = `✅ PIX confirmado!\n\n💰 Recarga de R$ ${recarga.valor.toFixed(2).replace('.', ',')} realizada com sucesso.\n\nO valor já está disponível na sua carteira POINT FFC.\n\n⚽ Boa sorte nas competições!`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: request.telegramUserId, text, entities: [{ type: 'bold', offset: 0, length: '✅ PIX confirmado!'.length }] }),
        signal: controller.signal,
      });
      if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) {
        throw new Error('Telegram message not accepted');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
