import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';

describe('Lineup service transaction boundaries', () => {
  let tx: any;
  let db: any;
  let service: LineupService;
  beforeEach(() => {
    tx = { usuario: { findUnique: jest.fn().mockResolvedValue({ status: 'ATIVO' }) },
      fantasyEscalacao: { findFirst: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      fantasyCompeticao: { findUnique: jest.fn() }, fantasyCatalogoAtleta: { findMany: jest.fn().mockResolvedValue([]) },
      fantasyEscalacaoAtleta: { deleteMany: jest.fn(), createMany: jest.fn() } };
    db = { $transaction: jest.fn(async (action: any) => action(tx)) };
    service = new LineupService(db as PrismaService);
  });
  it.each(['get','update','duplicate','remove'])('oculta recurso de outro usuario: %s', async action => {
    tx.fantasyEscalacao.findFirst.mockResolvedValue(null);
    let promise;
    if(action==='get') promise=service.get(22,1);
    else if(action==='update') promise=service.update(22,1,{versao:1});
    else if(action==='duplicate') promise=service.duplicate(22,1,1);
    else promise=service.remove(22,1,1);
    await expect(promise).rejects.toThrow('Escalacao nao encontrada');
    expect(tx.fantasyEscalacao.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id:1,usuarioId:22 } }));
    expect(tx.fantasyEscalacao.updateMany).not.toHaveBeenCalled();
  });
  it('usuario inativo nao pode operar', async () => {
    tx.usuario.findUnique.mockResolvedValue({status:'INATIVO'});
    await expect(service.create(1,1,{formacao:'4-3-3'})).rejects.toThrow('Usuario ativo');
  });
  it('rejeita versao antiga antes de qualquer escrita', async () => {
    tx.fantasyEscalacao.findFirst.mockResolvedValue({id:1,versao:2,status:'RASCUNHO'});
    await expect(service.update(1,1,{versao:1})).rejects.toThrow(ConflictException);
    expect(tx.fantasyEscalacao.updateMany).not.toHaveBeenCalled();
  });
  it('traduz deadlock/concorrencia para 409', async () => {
    db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('race',{code:'P2034',clientVersion:'5.22.0'}));
    await expect(service.get(1,1)).rejects.toThrow(ConflictException);
  });
  it('transacao Serializable envolve consulta do proprio usuario', async () => {
    tx.fantasyEscalacao.findFirst.mockResolvedValue(null);
    await expect(service.get(1,1)).rejects.toThrow();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'Serializable'});
  });
});
