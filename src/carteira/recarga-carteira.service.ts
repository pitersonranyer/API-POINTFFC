import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RecargaCarteiraStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AtualizarPixRecarga, CriarRecargaCarteira } from './recarga-carteira.types';

// Apenas persistência: nenhum método altera saldo ou cria movimentação financeira.
@Injectable()
export class RecargaCarteiraService {
  constructor(private readonly prisma: PrismaService) {}

  async criar(input: CriarRecargaCarteira) {
    this.validarId(input.carteiraId);
    const valor = this.validarValor(input.valor);
    this.validarTexto(input.provedor, 50);
    const externalReference = input.externalReference ?? randomUUID();
    this.validarTexto(externalReference, 255);
    if (input.idPagamentoExterno !== undefined) this.validarTexto(input.idPagamentoExterno, 255);
    try {
      return await this.prisma.recargaCarteira.create({ data: {
        carteiraId: input.carteiraId, valor, provedor: input.provedor,
        externalReference, idPagamentoExterno: input.idPagamentoExterno, status: 'PENDENTE',
      } });
    } catch (error) { this.tratarErro(error); }
  }

  consultarPorId(id: number) {
    this.validarId(id);
    return this.prisma.recargaCarteira.findUnique({ where: { id } });
  }

  consultarPorExternalReference(externalReference: string) {
    this.validarTexto(externalReference, 255);
    return this.prisma.recargaCarteira.findUnique({ where: { externalReference } });
  }

  consultarPorIdPagamentoExterno(idPagamentoExterno: string) {
    this.validarTexto(idPagamentoExterno, 255);
    return this.prisma.recargaCarteira.findUnique({ where: { idPagamentoExterno } });
  }

  async atualizarDadosPix(id: number, input: AtualizarPixRecarga) {
    this.validarId(id);
    await this.exigirPersistenciaSimples(id);
    if (input.idPagamentoExterno !== undefined) this.validarTexto(input.idPagamentoExterno, 255);
    for (const campo of ['pixCopiaCola', 'qrCode'] as const) {
      if (input[campo] !== undefined && input[campo] !== null && typeof input[campo] !== 'string') {
        throw new BadRequestException('Dados PIX inválidos');
      }
    }
    if (input.expiracao !== undefined && input.expiracao !== null &&
      (!(input.expiracao instanceof Date) || !Number.isFinite(input.expiracao.getTime()))) {
      throw new BadRequestException('Expiração inválida');
    }
    try {
      return await this.prisma.recargaCarteira.update({ where: { id }, data: {
        idPagamentoExterno: input.idPagamentoExterno, pixCopiaCola: input.pixCopiaCola,
        qrCode: input.qrCode, expiracao: input.expiracao,
      } });
    } catch (error) { this.tratarErro(error); }
  }

  async atualizarStatus(id: number, status: RecargaCarteiraStatus) {
    this.validarId(id);
    if (!Object.values(RecargaCarteiraStatus).includes(status)) throw new BadRequestException('Status inválido');
    await this.exigirPersistenciaSimples(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Preserva a primeira aprovação, inclusive em chamadas repetidas ou reembolso.
        if (status === 'APROVADA') {
          await tx.recargaCarteira.updateMany({ where: { id, aprovadoEm: null }, data: { aprovadoEm: new Date() } });
        }
        return tx.recargaCarteira.update({ where: { id }, data: { status } });
      });
    } catch (error) { this.tratarErro(error); }
  }

  private async exigirPersistenciaSimples(id: number) {
    const recarga = await this.consultarPorId(id);
    if (recarga?.provedor === 'MERCADO_PAGO') {
      throw new BadRequestException('Recarga Mercado Pago deve ser atualizada pelo fluxo oficial PIX');
    }
  }

  private validarId(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 4294967295) throw new BadRequestException('ID inválido');
  }

  private validarTexto(value: string, max: number) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BadRequestException('Identificador ou provedor inválido');
  }

  private validarValor(value: string | Prisma.Decimal): Prisma.Decimal {
    if (!(typeof value === 'string' || value instanceof Prisma.Decimal) ||
      (typeof value === 'string' && !/^\d+(\.\d{1,2})?$/.test(value))) {
      throw new BadRequestException('Informe valor decimal positivo com até duas casas');
    }
    const valor = new Prisma.Decimal(value);
    if (!valor.isFinite() || valor.lte(0) || valor.decimalPlaces() > 2 || valor.gt('9999999999.99')) {
      throw new BadRequestException('Valor inválido para Decimal(12,2)');
    }
    return valor;
  }

  private tratarErro(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ConflictException('Referência externa ou pagamento externo já cadastrado');
      if (error.code === 'P2003') throw new NotFoundException('Carteira não encontrada');
      if (error.code === 'P2025') throw new NotFoundException('Recarga não encontrada');
    }
    throw error;
  }
}
