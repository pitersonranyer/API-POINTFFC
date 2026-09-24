import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { calcularBasePremiacao, centavos, DecimalFinanceiro as Decimal } from '../ligas-competicoes/financeiro-competicao';
import { DashboardFinanceiroItemDto, DashboardFinanceiroQueryDto, DashboardFinanceiroResponseDto } from './dto/admin-dashboard-financeiro.dto';

const competicaoSelect = {
  id: true, nome: true, rodadaInicio: true, rodadaFim: true, status: true, tipoAcesso: true,
  valorInscricao: true, tipoTaxaPlataforma: true, valorTaxaPlataforma: true,
  ligaModalidade: { select: {
    liga: { select: { id: true, nome: true } },
    modalidade: { select: { id: true, nome: true, codigo: true } },
  } },
} satisfies Prisma.CompeticaoLigaSelect;

const premioSelect = {
  competicaoLigaId: true, posicaoInicio: true, posicaoFim: true,
  tipoPremiacao: true, valor: true, percentual: true, ordem: true,
} satisfies Prisma.PremiacaoCompeticaoSelect;
type Premio = Prisma.PremiacaoCompeticaoGetPayload<{ select: typeof premioSelect }>;

const zero = () => new Decimal(0);
const valoresVazios = () => ({ valorInscricoes: zero(), receitaPointPrevista: zero(),
  basePremiacao: zero(), premiacaoCalculada: zero(), saldoAposPremiacao: zero() });
type Valores = ReturnType<typeof valoresVazios>;
const serializar = (valores: Valores) => ({
  valorInscricoes: valores.valorInscricoes.toFixed(2), receitaPointPrevista: valores.receitaPointPrevista.toFixed(2),
  basePremiacao: valores.basePremiacao.toFixed(2), premiacaoCalculada: valores.premiacaoCalculada.toFixed(2),
  saldoAposPremiacao: valores.saldoAposPremiacao.toFixed(2),
});

@Injectable()
export class AdminDashboardFinanceiroService {
  constructor(private readonly prisma: PrismaService) {}

  consultar(query: DashboardFinanceiroQueryDto): Promise<DashboardFinanceiroResponseDto> {
    const where: Prisma.CompeticaoLigaWhereInput = {
      ...(query.ligaId !== undefined ? { ligaModalidade: { ligaId: query.ligaId } } : {}),
      ...(query.competicaoId !== undefined ? { id: query.competicaoId } : {}),
      ...(query.rodada !== undefined ? { rodadaInicio: { lte: query.rodada }, rodadaFim: { gte: query.rodada } } : {}),
    };
    return this.prisma.$transaction(async tx => {
      // Tres consultas em lote, sem carregar inscricoes individuais nem multiplicar joins.
      const competicoes = await tx.competicaoLiga.findMany({ where, select: competicaoSelect, orderBy: { id: 'asc' } });
      const grupos = await tx.inscricaoTimeCompeticao.groupBy({
        by: ['competicaoLigaId', 'statusInscricao'], where: { competicaoLiga: where },
        _count: { _all: true }, _sum: { valorInscricao: true },
      });
      const premios = await tx.premiacaoCompeticao.findMany({
        where: { competicaoLiga: where }, select: premioSelect,
        orderBy: [{ posicaoInicio: 'asc' }, { ordem: 'asc' }, { id: 'asc' }],
      });
      const inscricoes = new Map<number, { ativos: number; finalizados: number; cancelados: number; valor: Prisma.Decimal }>();
      for (const grupo of grupos) {
        const dados = inscricoes.get(grupo.competicaoLigaId) ?? { ativos: 0, finalizados: 0, cancelados: 0, valor: zero() };
        if (grupo.statusInscricao === 'CANCELADA') dados.cancelados += grupo._count._all;
        else {
          if (grupo.statusInscricao === 'ATIVA') dados.ativos += grupo._count._all;
          if (grupo.statusInscricao === 'FINALIZADA') dados.finalizados += grupo._count._all;
          dados.valor = dados.valor.plus(grupo._sum.valorInscricao ?? 0);
        }
        inscricoes.set(grupo.competicaoLigaId, dados);
      }
      const premiosPorCompeticao = new Map<number, Premio[]>();
      for (const premio of premios) {
        const lista = premiosPorCompeticao.get(premio.competicaoLigaId) ?? [];
        lista.push(premio);
        premiosPorCompeticao.set(premio.competicaoLigaId, lista);
      }
      const totais = valoresVazios();
      let totalInscritos = 0;
      let inscricoesCanceladas = 0;
      const itens: DashboardFinanceiroItemDto[] = [];
      const inicio = (query.pagina - 1) * query.limite;
      for (const [indice, competicao] of competicoes.entries()) {
        const dados = inscricoes.get(competicao.id) ?? { ativos: 0, finalizados: 0, cancelados: 0, valor: zero() };
        const totalConsiderado = dados.ativos + dados.finalizados;
        const tipo = competicao.tipoTaxaPlataforma;
        const taxa = competicao.valorTaxaPlataforma;
        const base = calcularBasePremiacao(competicao.id, dados.valor, totalConsiderado, tipo, taxa);
        const financeiro = valoresVazios();
        financeiro.valorInscricoes = dados.valor;
        financeiro.receitaPointPrevista = base.receitaPoint;
        financeiro.basePremiacao = base.basePremiacao;
        let fimAnterior = 0;
        let percentualTotal = zero();
        const premiacoes = (premiosPorCompeticao.get(competicao.id) ?? []).map(premio => {
          if (premio.posicaoInicio <= fimAnterior || premio.posicaoFim < premio.posicaoInicio) {
            throw new ConflictException(`Faixa de premiacao invalida na competicao ${competicao.id}.`);
          }
          fimAnterior = premio.posicaoFim;
          let valorCalculado: Prisma.Decimal;
          if (premio.tipoPremiacao === 'VALOR_FIXO') {
            if (premio.valor === null || premio.valor.lt(0) || premio.percentual !== null) {
              throw new ConflictException(`Premiacao fixa invalida na competicao ${competicao.id}.`);
            }
            valorCalculado = new Decimal(premio.valor).mul(premio.posicaoFim - premio.posicaoInicio + 1);
          } else {
            if (premio.posicaoInicio !== premio.posicaoFim || premio.percentual === null
              || premio.percentual.lte(0) || premio.percentual.gt(100) || premio.valor !== null) {
              throw new ConflictException(`Premiacao percentual invalida na competicao ${competicao.id}: exige posicao unica e percentual entre zero (exclusivo) e 100.`);
            }
            percentualTotal = percentualTotal.plus(premio.percentual);
            valorCalculado = financeiro.basePremiacao.mul(premio.percentual).div(100);
          }
          valorCalculado = centavos(valorCalculado);
          financeiro.premiacaoCalculada = financeiro.premiacaoCalculada.plus(valorCalculado);
          return { posicaoInicio: premio.posicaoInicio, posicaoFim: premio.posicaoFim,
            tipoPremiacao: premio.tipoPremiacao, valor: premio.valor?.toFixed(2) ?? null,
            percentual: premio.percentual?.toFixed(4) ?? null, ordem: premio.ordem, valorCalculado: valorCalculado.toFixed(2) };
        });
        if (percentualTotal.gt(100)) throw new ConflictException(`Soma percentual acima de 100 na competicao ${competicao.id}.`);
        financeiro.saldoAposPremiacao = financeiro.basePremiacao.minus(financeiro.premiacaoCalculada);
        for (const campo of Object.keys(totais) as Array<keyof Valores>) totais[campo] = totais[campo].plus(financeiro[campo]);
        totalInscritos += totalConsiderado;
        inscricoesCanceladas += dados.cancelados;
        if (indice >= inicio && indice < inicio + query.limite) itens.push({
          competicaoId: competicao.id, nome: competicao.nome, liga: competicao.ligaModalidade.liga,
          modalidade: competicao.ligaModalidade.modalidade, rodadaInicio: competicao.rodadaInicio,
          rodadaFim: competicao.rodadaFim, status: competicao.status, tipoAcesso: competicao.tipoAcesso,
          valorInscricao: competicao.valorInscricao.toFixed(2),
          inscritos: { ativos: dados.ativos, finalizados: dados.finalizados, cancelados: dados.cancelados, totalConsiderado },
          taxaPlataforma: { tipo, valor: taxa?.toFixed(2) ?? null }, financeiro: serializar(financeiro), premiacoes,
        });
      }
      return { natureza: 'PREVISTO_NOMINAL',
        totalizadores: { quantidadeCompeticoes: competicoes.length, totalInscritos, inscricoesCanceladas, ...serializar(totais) },
        itens, paginacao: { pagina: query.pagina, limite: query.limite, total: competicoes.length,
          totalPaginas: Math.ceil(competicoes.length / query.limite) } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
