import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DesafioRankingDto, DesafioRankingQueryDto } from './dto/desafio-ranking.dto';
import { statusDoDesafio } from './desafio-periodo';

@Injectable()
export class DesafioRankingService {
  constructor(private readonly prisma: PrismaService) {}

  consultar(id: number, query: DesafioRankingQueryDto): Promise<DesafioRankingDto> {
    return this.prisma.$transaction(async tx => {
      const agora = new Date();
      // Ranking permanece consultavel apos dataFim/ENCERRADO, sem expor rascunhos/cancelados.
      const desafio = await tx.desafio.findFirst({ where: { id, status: { in: ['ABERTO', 'EM_ANDAMENTO', 'ENCERRADO'] },
        publicadoEm: { lte: agora }, inicioInscricao: { lte: agora } }, select: { id: true, status: true, dataInicio: true } });
      if (!desafio) throw new NotFoundException('Desafio nao encontrado ou ranking indisponivel.');
      const partidas = await tx.desafioPartida.findMany({ where: { desafioId: id },
        select: { id: true, status: true, resultado: true, golsMandante: true, golsVisitante: true } });
      const validas = partidas.filter(p => p.status !== 'ANULADA');
      const apuradas = validas.filter(p => p.status === 'FINALIZADA' && p.resultado !== null
        && p.golsMandante !== null && p.golsVisitante !== null);
      const inscritos = await tx.desafioInscricao.findMany({ where: { desafioId: id, status: 'ATIVA' },
        select: { id: true, sequencia: true, usuarioId: true, usuario: { select: { idUsuario: true, nome: true, fotoUrl: true } } } });
      const somas = !apuradas.length || !inscritos.length ? [] : await tx.desafioPalpite.groupBy({
        by: ['inscricaoId'], where: { desafioId: id, inscricaoId: { in: inscritos.map(i => i.id) },
          desafioPartidaId: { in: apuradas.map(p => p.id) }, apurado: true, pontos: { in: [0, 1] } },
        _sum: { pontos: true },
      });
      const porInscricao = new Map(somas.map(s => [s.inscricaoId, s._sum.pontos?.toNumber() ?? 0]));
      const ordenados = inscritos.map(i => ({ participante: i.usuario, inscricaoId: i.id,
        numero: i.sequencia, nome: `Palpite ${i.sequencia}`, pontos: porInscricao.get(i.id) ?? 0 }))
        .sort((a, b) => b.pontos - a.pontos || a.participante.idUsuario - b.participante.idUsuario || a.numero - b.numero);
      let posicao = 0;
      const ranking = ordenados.map((row, index) => {
        if (index === 0 || row.pontos !== ordenados[index - 1].pontos) posicao = index + 1;
        return { ...row, posicao, acertos: row.pontos };
      });
      const total = ranking.length;
      return { desafioId: id, status: statusDoDesafio(desafio, agora), totalPartidasValidas: validas.length,
        totalPartidasApuradas: apuradas.length, totalPartidasAnuladas: partidas.length - validas.length,
        pontuacaoMaxima: validas.length, ranking: ranking.slice((query.pagina - 1) * query.limite, query.pagina * query.limite),
        paginacao: { pagina: query.pagina, limite: query.limite, total, totalPaginas: Math.ceil(total / query.limite) } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
