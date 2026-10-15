import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { LoteInscricao, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHash } from 'node:crypto';
import { CarteiraService } from '../carteira/carteira.service';
import { PrismaService } from '../prisma/prisma.service';
import { CriarLoteInscricaoDto, LoteInscricaoResponseDto } from './dto/lotes-inscricao.dto';
import { motivoBloqueioInscricao } from './inscricoes-competicao.service';

const limiteMonetario = new Prisma.Decimal('9999999999.99');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const conflito = (code: string, message: string, dados: Record<string, unknown> = {}) =>
  new ConflictException({ statusCode: 409, code, message, ...dados });
const inconsistencia = () => new InternalServerErrorException({
  code: 'INCONSISTENCIA_FINANCEIRA', message: 'Nao foi possivel confirmar o lote.',
});

@Injectable()
export class LotesInscricaoService {
  constructor(private readonly prisma: PrismaService, private readonly carteiras: CarteiraService) {}

  criarFree(competicaoId: number, usuarioId: number, dto: CriarLoteInscricaoDto, chave: string | undefined) {
    return this.criar(competicaoId, usuarioId, dto, chave, true);
  }

  async consultarResultadoFreeConfirmado(usuarioId: number, chave: string): Promise<{
    resposta: LoteInscricaoResponseDto;
    competenciaNome: string;
    times: Array<{ timeIdCartola: number; nomeTime: string }>;
  } | null> {
    if (!Number.isSafeInteger(usuarioId) || usuarioId < 1 || typeof chave !== 'string'
      || !/^[a-zA-Z0-9_-]{16,128}$/.test(chave)) return null;

    const lote = await this.prisma.loteInscricao.findUnique({
      where: { usuarioId_chaveIdempotenciaHash: { usuarioId, chaveIdempotenciaHash: hash(chave) } },
      include: {
        inscricoes: { orderBy: { timeIdCartola: 'asc' }, select: { timeIdCartola: true, nomeTime: true } },
        competicaoLiga: { select: { nome: true } },
      },
    });
    if (!lote || !lote.confirmadoEm || !lote.respostaOriginal) return null;

    const timesIds = lote.inscricoes.map(inscricao => inscricao.timeIdCartola);
    const requestHash = hash(JSON.stringify({
      versao: 1,
      competicaoId: lote.competicaoLigaId,
      timesCartolaIds: timesIds,
      valorUnitarioEsperado: '0.00',
    }));
    const resposta = this.replay(lote, requestHash);
    const respostaValida = lote.usuarioId === usuarioId && lote.tipoAcesso === 'FREE'
      && lote.valorUnitario.isZero() && lote.valorTotal.isZero() && lote.movimentacaoDebitoId === null
      && resposta.tipoAcesso === 'FREE' && resposta.competicaoId === lote.competicaoLigaId
      && resposta.quantidade === lote.quantidade && resposta.quantidade === timesIds.length
      && resposta.valorUnitario === '0.00' && resposta.valorTotal === '0.00'
      && resposta.movimentacaoDebitoId === null && resposta.saldoDisponivelAposOperacao === null
      && resposta.inscricoes.length === lote.inscricoes.length
      && resposta.inscricoes.every((inscricao, index) => inscricao.timeIdCartola === timesIds[index]
        && inscricao.statusInscricao === 'ATIVA');
    if (!respostaValida) throw inconsistencia();

    return { resposta, competenciaNome: lote.competicaoLiga.nome, times: lote.inscricoes };
  }

  async consultarResultadoPagoConfirmado(usuarioId: number, chave: string) {
    // Telegram sends an explicit quoted price. Recover the committed receipt,
    // including its historical balance, without charging or checking today's price.
    if (!Number.isSafeInteger(usuarioId) || usuarioId < 1 || !/^[a-zA-Z0-9_-]{16,128}$/.test(chave)) return null;
    const lote = await this.prisma.loteInscricao.findUnique({
      where: { usuarioId_chaveIdempotenciaHash: { usuarioId, chaveIdempotenciaHash: hash(chave) } },
      include: {
        inscricoes: { orderBy: { timeIdCartola: 'asc' } },
        competicaoLiga: { select: { nome: true } },
        movimentacaoDebito: { include: { carteira: { select: { usuarioId: true } } } },
      },
    });
    if (!lote || lote.tipoAcesso !== 'PAGO' || !lote.confirmadoEm || !lote.respostaOriginal) return null;
    const ids = lote.inscricoes.map(item => item.timeIdCartola);
    const resposta = this.replay(lote, hash(JSON.stringify({ versao: 1, competicaoId: lote.competicaoLigaId,
      timesCartolaIds: ids, valorUnitarioEsperado: lote.valorUnitario.toFixed(2) })));
    const debito = lote.movimentacaoDebito;
    if (lote.usuarioId !== usuarioId || lote.moeda !== 'BRL' || !lote.valorUnitario.gt(0)
      || !lote.valorTotal.equals(lote.valorUnitario.mul(ids.length)) || lote.quantidade !== ids.length
      || !debito || debito.id !== lote.movimentacaoDebitoId || debito.carteira.usuarioId !== usuarioId
      || debito.tipo !== 'DEBITO' || debito.origem !== 'INSCRICAO' || debito.status !== 'CONFIRMADA'
      || debito.referenciaId !== `lote:${lote.id}` || !debito.valor.equals(lote.valorTotal)
      || debito.saldoPosterior.isNegative() || !debito.saldoAnterior.minus(debito.valor).equals(debito.saldoPosterior)
      || resposta.loteId !== lote.id || resposta.competicaoId !== lote.competicaoLigaId || resposta.tipoAcesso !== 'PAGO'
      || resposta.quantidade !== ids.length || resposta.moeda !== 'BRL' || resposta.movimentacaoDebitoId !== debito.id
      || resposta.valorUnitario !== lote.valorUnitario.toFixed(2) || resposta.valorTotal !== lote.valorTotal.toFixed(2)
      || resposta.saldoDisponivelAposOperacao !== debito.saldoPosterior.toFixed(2)
      || resposta.inscricoes.length !== ids.length || resposta.inscricoes.some((item, index) => {
        const inscricao = lote.inscricoes[index];
        return item.id !== inscricao.id || item.timeIdCartola !== inscricao.timeIdCartola || item.statusInscricao !== 'ATIVA'
          || inscricao.usuarioId !== usuarioId || inscricao.loteInscricaoId !== lote.id
          || inscricao.competicaoLigaId !== lote.competicaoLigaId || !inscricao.valorInscricao.equals(lote.valorUnitario);
      })) throw inconsistencia();
    return { resposta, competenciaNome: lote.competicaoLiga.nome, times: lote.inscricoes };
  }

  async criar(competicaoId: number, usuarioId: number, dto: CriarLoteInscricaoDto,
    chave: string | undefined, somenteFree = false): Promise<LoteInscricaoResponseDto> {
    // Cada tentativa e uma transacao integral. Somente conflitos do banco sao repetidos.
    for (let tentativa = 0; ; tentativa++) {
      try {
        return await this.prisma.$transaction(async tx => {
          const entrada = plainToInstance(CriarLoteInscricaoDto, dto);
          if (!entrada || (await validate(entrada, { whitelist: true, forbidNonWhitelisted: true })).length
            || ![competicaoId, usuarioId].every(id => Number.isSafeInteger(id) && id > 0 && id <= 4294967295)
            || typeof chave !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(chave)) {
            throw new BadRequestException('DTO, identificador ou Idempotency-Key invalido.');
          }
          const timesIds = [...entrada.timesCartolaIds].sort((a, b) => a - b);
          const esperado = entrada.valorUnitarioEsperado === undefined ? null
            : new Prisma.Decimal(entrada.valorUnitarioEsperado).toFixed(2);
          const chaveIdempotenciaHash = hash(chave);
          const requestHash = hash(JSON.stringify({ versao: 1, competicaoId, timesCartolaIds: timesIds, valorUnitarioEsperado: esperado }));
          const where = { usuarioId_chaveIdempotenciaHash: { usuarioId, chaveIdempotenciaHash } };
          await this.validarUsuario(tx, usuarioId);
          const anterior = await tx.loteInscricao.findUnique({ where });
          if (anterior) return this.replay(anterior, requestHash);

          // Mesma ordem do fluxo legado: competicao antes de usuario/carteira.
          // O lock de usuario serializa a chave inclusive entre competicoes diferentes.
          const competicoes = await tx.$queryRaw<{ ID: number }[]>`
            SELECT ID FROM COMPETICAO_LIGA WHERE ID = ${competicaoId} FOR UPDATE`;
          const usuarios = await tx.$queryRaw<{ id_usuario: number }[]>`
            SELECT id_usuario FROM USUARIO WHERE id_usuario = ${usuarioId} FOR UPDATE`;
          if (!usuarios.length) throw new NotFoundException('Usuario nao encontrado.');
          await this.validarUsuario(tx, usuarioId);
          const concorrente = await tx.loteInscricao.findUnique({ where });
          if (concorrente) return this.replay(concorrente, requestHash);
          if (!competicoes.length) throw new NotFoundException('Competicao nao encontrada.');

          const competicao = await tx.competicaoLiga.findUniqueOrThrow({ where: { id: competicaoId }, include: {
            ligaModalidade: { include: { liga: true, modalidade: true } },
          } });
          if (somenteFree && (competicao.tipoAcesso !== 'FREE' || !competicao.valorInscricao.isZero())) {
            throw conflito('COMPETICAO_NAO_FREE', 'Esta operação aceita somente competições gratuitas.');
          }
          const now = new Date();
          const bloqueio = motivoBloqueioInscricao(competicao, now);
          if (bloqueio) throw conflito(bloqueio, 'Inscricoes indisponiveis para esta competicao.');

          // Protege os vinculos contra remocao entre a validacao e o commit.
          await tx.$queryRaw`SELECT TIME_ID FROM TIME_USUARIO
            WHERE USUARIO_ID = ${usuarioId} AND TIME_ID IN (${Prisma.join(timesIds)}) ORDER BY TIME_ID FOR UPDATE`;
          const times = await tx.timeUsuario.findMany({ where: { usuarioId, timeId: { in: timesIds } } });
          const porTime = new Map(times.map(time => [time.timeId, time]));
          const ausentes = timesIds.filter(id => !porTime.has(id));
          if (ausentes.length) throw new NotFoundException({
            code: 'TIME_NAO_PERTENCE_AO_USUARIO', message: 'Um ou mais times nao pertencem ao usuario.',
            errors: ausentes.map(timeIdCartola => ({ timeIdCartola, reason: 'TIME_NAO_PERTENCE_AO_USUARIO' })),
          });
          const existentes = await tx.inscricaoTimeCompeticao.findMany({ where: {
            competicaoLigaId: competicaoId, timeIdCartola: { in: timesIds },
          }, select: { timeIdCartola: true } });
          if (existentes.length) throw conflito('TIME_JA_INSCRITO', 'Lote contem time ja inscrito.', {
            errors: existentes.map(time => ({ ...time, reason: 'TIME_JA_INSCRITO' })),
          });
          const quantidade = timesIds.length;
          if (competicao.limiteTimesUsuario !== null) {
            const count = await tx.inscricaoTimeCompeticao.count({ where: { competicaoLigaId: competicaoId, usuarioId, statusInscricao: 'ATIVA' } });
            if (count + quantidade > competicao.limiteTimesUsuario) {
              throw conflito('LIMITE_TIMES_USUARIO_ATINGIDO', 'Limite de times por usuario atingido.');
            }
          }
          if (competicao.limiteParticipantes !== null) {
            const count = await tx.inscricaoTimeCompeticao.count({ where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' } });
            if (count + quantidade > competicao.limiteParticipantes) {
              throw conflito('LIMITE_PARTICIPANTES_ATINGIDO', 'Limite de participantes atingido.');
            }
          }
          const unitario = competicao.valorInscricao;
          const total = unitario.mul(quantidade);
          if (!total.isFinite() || total.isNegative() || total.gt(limiteMonetario) || total.decimalPlaces() > 2) {
            throw conflito('VALOR_LOTE_INVALIDO', 'Valor total fora do limite permitido.');
          }
          if (esperado !== null && !unitario.equals(esperado)) throw conflito('PRECO_INSCRICAO_ALTERADO', 'O preco da inscricao foi alterado.', {
            valorEsperado: esperado, valorAtual: unitario.toFixed(2), quantidade, valorTotalAtual: total.toFixed(2),
          });

          const lote = await tx.loteInscricao.create({ data: {
            usuarioId, competicaoLigaId: competicaoId, chaveIdempotenciaHash, requestHash,
            tipoAcesso: competicao.tipoAcesso, quantidade, valorUnitario: unitario, valorTotal: total, moeda: 'BRL',
          } });
          for (const timeId of timesIds) {
            const time = porTime.get(timeId)!;
            await tx.inscricaoTimeCompeticao.create({ data: {
              competicaoLigaId: competicaoId, usuarioId, loteInscricaoId: lote.id, timeIdCartola: timeId,
              nomeTime: time.nome, nomeCartoleiro: time.nomeCartola, escudoUrl: time.urlEscudoPng,
              valorInscricao: unitario, statusInscricao: 'ATIVA', dataInscricao: now,
            } });
          }
          if (competicao.tipoAcesso === 'PAGO') {
            const carteira = await this.carteiras.obterOuCriarEmTransacao(tx, usuarioId);
            if (carteira.usuarioId !== usuarioId) throw inconsistencia();
            if (carteira.status !== 'ATIVA') throw conflito('CARTEIRA_BLOQUEADA', 'Carteira bloqueada.');
            if (carteira.saldoDisponivel.isNegative() || carteira.saldoBloqueado.isNegative()) throw inconsistencia();
            if (carteira.saldoDisponivel.lt(total)) throw conflito('SALDO_INSUFICIENTE', 'Saldo insuficiente para inscrever todos os times.', {
              saldoDisponivel: carteira.saldoDisponivel.toFixed(2), valorNecessario: total.toFixed(2),
              valorFaltante: total.minus(carteira.saldoDisponivel).toFixed(2), moeda: 'BRL',
            });
            const debito = await this.carteiras.debitarEmTransacao(tx, {
              usuarioId, valor: total, origem: 'INSCRICAO', referenciaId: `lote:${lote.id}`,
              descricao: `Inscricao de ${quantidade} time(s) na competicao ${competicaoId}`,
            });
            await tx.loteInscricao.update({ where: { id: lote.id }, data: { movimentacaoDebitoId: debito.id } });
          }

          const resposta = await this.validarResultado(tx, lote.id, usuarioId, competicaoId, timesIds, unitario);
          await tx.loteInscricao.update({ where: { id: lote.id }, data: {
            respostaOriginal: resposta as unknown as Prisma.InputJsonObject, confirmadoEm: new Date(),
          } });
          return resposta;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 20000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if ((error.code === 'P2034' || error.code === 'P2002') && tentativa < 2) continue;
          if (error.code === 'P2034' || error.code === 'P2028') {
            throw conflito('INSCRICAO_CONCORRENTE', 'Tente novamente com a mesma Idempotency-Key.');
          }
          if (error.code === 'P2002') throw conflito('CONFLITO_INSCRICAO', 'Conflito ao registrar o lote; repita com a mesma chave.');
        }
        throw error;
      }
    }
  }

  private async validarUsuario(tx: Prisma.TransactionClient, usuarioId: number) {
    const usuario = await tx.usuario.findUnique({ where: { idUsuario: usuarioId }, select: { status: true } });
    if (!usuario) throw new NotFoundException('Usuario nao encontrado.');
    if (usuario.status !== 'ATIVO') throw new ForbiddenException('Usuario indisponivel.');
  }

  private replay(lote: LoteInscricao, requestHash: string): LoteInscricaoResponseDto {
    if (lote.requestHash !== requestHash) throw conflito('IDEMPOTENCY_KEY_REUTILIZADA', 'Idempotency-Key utilizada com outro pedido.');
    if (!lote.confirmadoEm || !lote.respostaOriginal) throw conflito('LOTE_NAO_CONFIRMADO', 'Lote ainda nao confirmado.');
    return lote.respostaOriginal as unknown as LoteInscricaoResponseDto;
  }

  private async validarResultado(tx: Prisma.TransactionClient, loteId: number, usuarioId: number,
    competicaoId: number, timesIds: number[], unitario: Prisma.Decimal): Promise<LoteInscricaoResponseDto> {
    const lote = await tx.loteInscricao.findUniqueOrThrow({ where: { id: loteId }, include: {
      inscricoes: { orderBy: { timeIdCartola: 'asc' } }, movimentacaoDebito: { include: { carteira: true } },
    } });
    const soma = lote.inscricoes.reduce((valor, inscricao) => valor.plus(inscricao.valorInscricao), new Prisma.Decimal(0));
    if (lote.usuarioId !== usuarioId || lote.competicaoLigaId !== competicaoId || lote.moeda !== 'BRL'
      || lote.quantidade !== timesIds.length || lote.inscricoes.length !== timesIds.length
      || !lote.valorUnitario.equals(unitario) || !lote.valorTotal.equals(unitario.mul(timesIds.length))
      || !soma.equals(lote.valorTotal) || lote.inscricoes.some((inscricao, index) =>
        inscricao.usuarioId !== usuarioId || inscricao.competicaoLigaId !== competicaoId
        || inscricao.loteInscricaoId !== loteId || inscricao.timeIdCartola !== timesIds[index]
        || inscricao.statusInscricao !== 'ATIVA' || !inscricao.valorInscricao.equals(unitario))) throw inconsistencia();

    const debito = lote.movimentacaoDebito;
    if (lote.tipoAcesso === 'PAGO') {
      // FK unica representa exatamente uma movimentacao vinculada; reler protege as invariantes antes do commit.
      if (!unitario.gt(0) || !debito || debito.id !== lote.movimentacaoDebitoId
        || debito.tipo !== 'DEBITO' || debito.origem !== 'INSCRICAO' || debito.status !== 'CONFIRMADA'
        || debito.carteira.usuarioId !== usuarioId || debito.carteira.status !== 'ATIVA'
        || !debito.valor.equals(lote.valorTotal) || debito.referenciaId !== `lote:${loteId}`
        || debito.saldoPosterior.isNegative() || !debito.saldoAnterior.minus(debito.valor).equals(debito.saldoPosterior)
        || !debito.carteira.saldoDisponivel.equals(debito.saldoPosterior)) throw inconsistencia();
    } else if (lote.tipoAcesso !== 'FREE' || !unitario.isZero() || !lote.valorTotal.isZero()
      || lote.movimentacaoDebitoId !== null || debito !== null) throw inconsistencia();
    return {
      loteId, competicaoId, quantidade: lote.quantidade, tipoAcesso: lote.tipoAcesso, moeda: lote.moeda,
      valorUnitario: lote.valorUnitario.toFixed(2), valorTotal: lote.valorTotal.toFixed(2),
      movimentacaoDebitoId: lote.movimentacaoDebitoId, saldoDisponivelAposOperacao: debito?.saldoPosterior.toFixed(2) ?? null,
      inscricoes: lote.inscricoes.map(({ id, timeIdCartola, statusInscricao }) => ({ id, timeIdCartola, statusInscricao })),
    };
  }
}
