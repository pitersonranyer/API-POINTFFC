import { ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Desafio, DesafioPartida, Prisma } from '@prisma/client';
import { CarteiraService } from '../carteira/carteira.service';
import { PrismaService } from '../prisma/prisma.service';
import { mapearMinhaDesafioInscricao, MinhaDesafioInscricaoRow, minhaDesafioInscricaoSelect } from './desafio-inscricao';
import { DesafioParticipacaoDto } from './dto/desafio-participacao.dto';

const conflito = (code: string, message: string, dados: Record<string, unknown> = {}) =>
  new ConflictException({ statusCode: 409, code, message, ...dados });

function resposta(inscricao: MinhaDesafioInscricaoRow): DesafioParticipacaoDto {
  return { inscricao: mapearMinhaDesafioInscricao(inscricao),
    tipoAcesso: inscricao.valorInscricao.isZero() ? 'FREE' : 'PAGO', valorCobrado: inscricao.valorInscricao.toFixed(2) };
}

type PartidaElegivel = Pick<DesafioPartida, 'id' | 'status' | 'dataInicio' | 'resultado' | 'golsMandante' | 'golsVisitante'>;

function validarPrazo(desafio: Desafio, partidas: PartidaElegivel[], agora: Date): void {
  if (desafio.status !== 'ABERTO' || !desafio.publicadoEm || desafio.publicadoEm > agora) {
    throw conflito('DESAFIO_INDISPONIVEL', 'Desafio nao aceita novas participacoes.');
  }
  if (agora < desafio.inicioInscricao || agora >= desafio.fimInscricao || agora >= desafio.dataInicio || agora >= desafio.dataFim) {
    throw conflito('FORA_JANELA_INSCRICAO', 'Prazo de participacao indisponivel ou encerrado.');
  }
  if (!partidas.length) throw conflito('SEM_PARTIDAS_ELEGIVEIS', 'Desafio nao possui partidas elegiveis.');
  if (partidas.some(p => p.status !== 'AGENDADA' || p.dataInicio <= agora || p.resultado !== null
    || p.golsMandante !== null || p.golsVisitante !== null)) {
    throw conflito('PARTIDAS_INDISPONIVEIS', 'Uma partida do Desafio ja iniciou ou nao permite nova participacao.');
  }
}

@Injectable()
export class DesafioParticipacaoService {
  constructor(private readonly prisma: PrismaService, private readonly carteiras: CarteiraService) {}

  async participar(desafioId: number, usuarioId: number): Promise<DesafioParticipacaoDto> {
    try {
      return await this.prisma.$transaction(async tx => {
        // Serializa vagas, composicao, palpites e inscricoes antes de contar ou cobrar.
        // Ordem compativel com as inscricoes existentes: recurso -> USUARIO -> CARTEIRA.
        const desafios = await tx.$queryRaw<Array<{ ID: number | bigint }>>`
          SELECT ID FROM DESAFIO WHERE ID = ${desafioId} FOR UPDATE`;
        if (!desafios.length) throw new NotFoundException('Desafio nao encontrado.');
        const usuarios = await tx.$queryRaw<Array<{ id_usuario: number | bigint }>>`
          SELECT id_usuario FROM USUARIO WHERE id_usuario = ${usuarioId} FOR UPDATE`;
        if (!usuarios.length) throw new NotFoundException('Usuario nao encontrado.');
        const usuario = await tx.usuario.findUnique({ where: { idUsuario: usuarioId }, select: { status: true } });
        if (!usuario || usuario.status !== 'ATIVO') throw new ForbiddenException('Usuario indisponivel.');

        const existente = await tx.desafioInscricao.findUnique({
          where: { desafioId_usuarioId: { desafioId, usuarioId } }, select: minhaDesafioInscricaoSelect,
        });
        // Replay antes de vagas/prazo/saldo: confirma o snapshot original sem nova operacao.
        if (existente?.status === 'ATIVA') return resposta(existente);
        if (existente) throw conflito('INSCRICAO_CANCELADA', 'Inscricao cancelada nao pode ser reativada neste fluxo.');

        const desafio = await tx.desafio.findUnique({ where: { id: desafioId } });
        if (!desafio) throw new NotFoundException('Desafio nao encontrado.');
        const partidas = await tx.desafioPartida.findMany({ where: { desafioId, status: { not: 'ANULADA' } },
          select: { id: true, status: true, dataInicio: true, resultado: true, golsMandante: true, golsVisitante: true },
          orderBy: { id: 'asc' } });
        validarPrazo(desafio, partidas, new Date());

        const valor = desafio.valorInscricao;
        if (!valor.isFinite() || valor.isNegative() || valor.gt('9999999999.99') || valor.decimalPlaces() > 2
          || (desafio.tipoAcesso === 'FREE' ? !valor.isZero() : desafio.tipoAcesso !== 'PAGO' || !valor.gt(0))) {
          throw conflito('VALOR_INSCRICAO_INVALIDO', 'Valor de inscricao do Desafio invalido.');
        }
        if (desafio.limiteParticipantes !== null) {
          const inscritos = await tx.desafioInscricao.count({ where: { desafioId, status: 'ATIVA' } });
          if (inscritos >= desafio.limiteParticipantes) {
            throw conflito('LIMITE_PARTICIPANTES_ATINGIDO', 'Limite de participantes atingido.');
          }
        }
        const palpites = await tx.desafioPalpite.findMany({
          where: { desafioId, usuarioId, desafioPartidaId: { in: partidas.map(p => p.id) } },
          select: { desafioPartidaId: true },
        });
        const preenchidas = new Set(palpites.map(p => p.desafioPartidaId));
        const partidaIds = partidas.filter(p => !preenchidas.has(p.id)).map(p => p.id);
        if (partidaIds.length) throw conflito('PALPITES_INCOMPLETOS', 'Preencha os palpites de todas as partidas elegiveis.', { partidaIds });

        let movimentacaoDebitoId: number | null = null;
        if (desafio.tipoAcesso === 'PAGO') {
          // Somente carteira ja existente. Ausencia equivale a saldo zero e nunca cria carteira/recarga.
          await tx.$queryRaw`SELECT id FROM CARTEIRA WHERE usuarioId = ${usuarioId} FOR UPDATE`;
          const carteira = await tx.carteira.findUnique({ where: { usuarioId } });
          if (carteira && carteira.status !== 'ATIVA') throw conflito('CARTEIRA_BLOQUEADA', 'Carteira bloqueada.');
          if (carteira && (carteira.saldoDisponivel.isNegative() || carteira.saldoBloqueado.isNegative())) {
            throw new InternalServerErrorException({ code: 'INCONSISTENCIA_FINANCEIRA', message: 'Carteira indisponivel.' });
          }
          const saldo = carteira?.saldoDisponivel ?? new Prisma.Decimal(0);
          if (saldo.lt(valor)) throw conflito('SALDO_INSUFICIENTE', 'Adicione saldo a carteira para participar do Desafio.', {
            saldoDisponivel: saldo.toFixed(2), valorNecessario: valor.toFixed(2), valorFaltante: valor.minus(saldo).toFixed(2), moeda: 'BRL',
          });
          validarPrazo(desafio, partidas, new Date());
          const debito = await this.carteiras.debitarEmTransacao(tx, { usuarioId, valor, origem: 'INSCRICAO',
            referenciaId: `desafio:${desafioId}:usuario:${usuarioId}`, descricao: `Participacao no Desafio ${desafioId}` });
          movimentacaoDebitoId = debito.id;
        }
        validarPrazo(desafio, partidas, new Date());
        const inscricao = await tx.desafioInscricao.create({ data: { desafioId, usuarioId, status: 'ATIVA',
          valorInscricao: valor, movimentacaoDebitoId, dataInscricao: new Date() }, select: minhaDesafioInscricaoSelect });
        // Escrita que atravessa o prazo tambem desfaz debito, movimento e inscricao.
        validarPrazo(desafio, partidas, new Date());
        return resposta(inscricao);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 20000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') throw conflito('INSCRICAO_DUPLICADA', 'Participacao ja registrada; consulte o Desafio.');
        if (error.code === 'P2034' || error.code === 'P2028') {
          throw conflito('PARTICIPACAO_CONCORRENTE', 'Nao foi possivel confirmar agora; repita a solicitacao.');
        }
      }
      throw error;
    }
  }
}
