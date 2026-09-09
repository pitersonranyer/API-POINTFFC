import { BadGatewayException, BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Carteira, MovimentacaoCarteiraOrigem, MovimentacaoCarteiraTipo, Prisma, RecargaCarteira, RecargaCarteiraStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OperacaoCarteira } from './carteira.types';
import { normalizarIdsRaw, RawIds } from './raw-ids';

const LIMITE = new Prisma.Decimal('9999999999.99');

export interface RecargaPixOficial {
  idPagamentoExterno: string;
  externalReference: string;
  valor: Prisma.Decimal;
  status: RecargaCarteiraStatus | null;
  pixCopiaCola?: string;
  qrCode?: string;
  expiracao?: Date;
}

// Regra arquitetural: todas as escritas financeiras devem passar por este serviço.
// Não oferece alteração de saldo bloqueado nem edição/exclusão de movimentações.
@Injectable()
export class CarteiraService {
  constructor(private readonly prisma: PrismaService) {}

  obterOuCriar(usuarioId: number): Promise<Carteira> {
    return this.prisma.$transaction((tx) => this.obterComBloqueio(tx, usuarioId));
  }

  async consultarExtrato(usuarioId: number) {
    const carteira = await this.obterOuCriar(usuarioId);
    return this.prisma.movimentacaoCarteira.findMany({
      where: { carteiraId: carteira.id }, orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    });
  }

  creditar(input: OperacaoCarteira) {
    return this.movimentar(input, 'CREDITO');
  }

  debitar(input: OperacaoCarteira) {
    return this.movimentar(input, 'DEBITO');
  }

  // Recebe exclusivamente dados já consultados no provedor pelo fluxo interno PIX.
  // Recarga -> carteira é a ordem de locks; nenhuma chamada externa ocorre aqui.
  aplicarRecargaPix(recargaId: number, oficial: RecargaPixOficial) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawIds<RecargaCarteira, 'id' | 'carteiraId'>[]>`
        SELECT * FROM RECARGA_CARTEIRA WHERE id = ${recargaId} FOR UPDATE`;
      const recarga = rows[0] && normalizarIdsRaw(rows[0], ['id', 'carteiraId']);
      if (!recarga) throw new NotFoundException('Recarga não encontrada');
      if (recarga.provedor !== 'MERCADO_PAGO' || recarga.externalReference !== oficial.externalReference ||
        !recarga.valor.equals(oficial.valor) ||
        (recarga.idPagamentoExterno !== null && recarga.idPagamentoExterno !== oficial.idPagamentoExterno)) {
        throw new BadGatewayException('Order incompatível com a recarga');
      }
      const movimento = await tx.movimentacaoCarteira.findUnique({ where: { recargaId } });
      // Reembolso não estorna saldo nesta fase e não pode ser desfeito por aprovação atrasada.
      const status = recarga.status === 'REEMBOLSADA' ? recarga.status
        : movimento && oficial.status !== 'REEMBOLSADA' ? 'APROVADA' : oficial.status ?? recarga.status;
      if (status === 'APROVADA' && oficial.status === 'APROVADA' && !movimento) {
        const carteiras = await tx.$queryRaw<RawIds<Carteira, 'id' | 'usuarioId'>[]>`
          SELECT * FROM CARTEIRA WHERE id = ${recarga.carteiraId} FOR UPDATE`;
        const carteira = carteiras[0] && normalizarIdsRaw(carteiras[0], ['id', 'usuarioId']);
        if (!carteira || carteira.status !== 'ATIVA') {
          throw new ServiceUnavailableException('Crédito pendente: carteira indisponível');
        }
        const valor = this.validarValor(recarga.valor);
        const anterior = carteira.saldoDisponivel;
        const posterior = anterior.plus(valor);
        if (anterior.isNegative() || carteira.saldoBloqueado.isNegative() || posterior.gt(LIMITE)) {
          throw new ServiceUnavailableException('Crédito pendente: saldo fora do limite');
        }
        await tx.carteira.update({ where: { id: carteira.id }, data: { saldoDisponivel: posterior } });
        await tx.movimentacaoCarteira.create({ data: {
          carteiraId: carteira.id, recargaId, tipo: 'CREDITO', origem: 'RECARGA_PIX', valor,
          saldoAnterior: anterior, saldoPosterior: posterior, referenciaId: String(recargaId), status: 'CONFIRMADA',
        } });
      }
      return tx.recargaCarteira.update({ where: { id: recargaId }, data: {
        idPagamentoExterno: oficial.idPagamentoExterno, status,
        pixCopiaCola: oficial.pixCopiaCola, qrCode: oficial.qrCode, expiracao: oficial.expiracao,
        aprovadoEm: status === 'APROVADA' ? recarga.aprovadoEm ?? new Date() : undefined,
      } });
    });
  }

  private async obterComBloqueio(tx: Prisma.TransactionClient, usuarioId: number): Promise<Carteira> {
    if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0) throw new BadRequestException('Usuário inválido');
    // A linha de usuário existe antes da carteira: serializa também a primeira criação.
    const usuarios = await tx.$queryRaw<{ id_usuario: number | bigint }[]>`
      SELECT id_usuario FROM USUARIO WHERE id_usuario = ${usuarioId} FOR UPDATE`;
    if (!usuarios.length) throw new NotFoundException('Usuário não encontrado');
    normalizarIdsRaw(usuarios[0], ['id_usuario']);
    await tx.carteira.upsert({ where: { usuarioId }, create: { usuarioId }, update: {} });
    const carteiras = await tx.$queryRaw<RawIds<Carteira, 'id' | 'usuarioId'>[]>`
      SELECT * FROM CARTEIRA WHERE usuarioId = ${usuarioId} FOR UPDATE`;
    return normalizarIdsRaw(carteiras[0], ['id', 'usuarioId']);
  }

  private validarValor(valor: string | Prisma.Decimal): Prisma.Decimal {
    if (!(typeof valor === 'string' || valor instanceof Prisma.Decimal)) {
      throw new BadRequestException('Informe valor como texto decimal ou Decimal');
    }
    if (typeof valor === 'string' && !/^-?\d+(\.\d{1,2})?$/.test(valor)) {
      throw new BadRequestException('Valor deve ter no máximo duas casas decimais');
    }
    const decimal = new Prisma.Decimal(valor);
    if (!decimal.isFinite() || decimal.lte(0) || decimal.decimalPlaces() > 2 || decimal.gt(LIMITE)) {
      throw new BadRequestException('Valor inválido para Decimal(12,2)');
    }
    return decimal;
  }

  private async movimentar(input: OperacaoCarteira, tipo: MovimentacaoCarteiraTipo) {
    if (input.origem === 'RECARGA_PIX') throw new BadRequestException('PIX exige crédito vinculado à recarga oficial');
    const valor = this.validarValor(input.valor);
    if (!Object.values(MovimentacaoCarteiraOrigem).includes(input.origem)) {
      throw new BadRequestException('Origem inválida');
    }
    return this.prisma.$transaction(async (tx) => {
      const carteira = await this.obterComBloqueio(tx, input.usuarioId);
      if (carteira.status !== 'ATIVA') throw new BadRequestException('Carteira bloqueada');
      const anterior = carteira.saldoDisponivel;
      if (anterior.isNegative() || carteira.saldoBloqueado.isNegative()) {
        throw new BadRequestException('Carteira com saldo inválido');
      }
      if (tipo === 'DEBITO' && anterior.lt(valor)) throw new BadRequestException('Saldo insuficiente');
      const posterior = tipo === 'CREDITO' ? anterior.plus(valor) : anterior.minus(valor);
      if (posterior.isNegative() || posterior.gt(LIMITE)) throw new BadRequestException('Saldo fora do limite');
      await tx.carteira.update({ where: { id: carteira.id }, data: { saldoDisponivel: posterior } });
      return tx.movimentacaoCarteira.create({ data: {
        carteiraId: carteira.id, tipo, origem: input.origem, valor,
        saldoAnterior: anterior, saldoPosterior: posterior,
        referenciaId: input.referenciaId, descricao: input.descricao, status: 'CONFIRMADA',
      } });
    });
  }
}
