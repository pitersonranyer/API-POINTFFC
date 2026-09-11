import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { FutebolQueryService } from '../src/futebol/futebol-query.service';
import { vinculoCartola } from '../src/futebol/futebol-cartola';

const suite = process.env.FUTEBOL_INTEGRATION_TEST === '1' ? describe : describe.skip;
suite('Futebol não-BSA no MySQL (rollback obrigatório)', () => {
  it('persiste clubes sem Cartola e responde sem resolver provedor externo', async () => {
    const prisma = new PrismaClient();
    const rollback = new Error('rollback de validação');
    const externalId = 4000000000 + Math.floor(Math.random() * 100000000);
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('HTTP externo proibido'));
    try {
      await expect(prisma.$transaction(async tx => {
        const competencia = await tx.futebolCompeticao.create({ data: {
          externalId, codigo: 'T' + externalId.toString().slice(-9), nome: 'Teste isolado', pais: 'Teste',
          tipo: 'LEAGUE', temporadaAtual: 2026,
        } });
        const base = { nomeOriginal: 'Clube teste', nome: 'Clube teste', pais: 'Teste',
          cartolaClubeId: vinculoCartola(competencia.codigo, externalId).cartolaClubeId ?? null };
        const home = await tx.futebolTime.create({ data: { ...base, externalId } });
        const away = await tx.futebolTime.create({ data: { ...base, externalId: externalId + 1 } });
        expect(home.cartolaClubeId).toBeNull();
        await tx.futebolPartida.create({ data: {
          externalId, competicaoId: competencia.id, temporada: 2026, rodada: 1,
          timeMandanteId: home.id, timeVisitanteId: away.id, dataHoraUtc: new Date('2026-09-12T00:00:00Z'),
          status: 'TIMED', ultimaAtualizacaoApi: new Date(),
        } });
        const response = await new FutebolQueryService(tx as unknown as PrismaService).listarJogos(competencia.codigo, {});
        expect(response.total).toBe(1);
        expect(response.jogos[0].mandante.cartolaClubeId).toBeNull();
        expect(response.jogos[0].visitante.cartolaClubeId).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await prisma.futebolTime.count({ where: { externalId: { in: [externalId, externalId + 1] } } })).toBe(0);
      expect(await prisma.futebolCompeticao.count({ where: { externalId } })).toBe(0);
    } finally { fetchSpy.mockRestore(); await prisma.$disconnect(); }
  });
});
