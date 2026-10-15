import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';
import { FORMATION_COUNTS } from '../src/point-fantasy/lineups/lineup.rules';

const url = process.env.POINT_FANTASY_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Fantasy lineups real MySQL integration (dedicated test database)', () => {
  let db: PrismaClient;
  let service: LineupService;
  let user: number, other: number, catalog: number, otherCatalog: number, competition: number;
  let blockedClub: number, otherSnapshot: number;
  const starters: Record<number, number[]> = {};
  const reserves: Record<number, number[]> = {};
  let coach: number;
  const token = `lineup-${Date.now()}`;
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.protocol !== 'mysql:' || !['localhost','127.0.0.1'].includes(target.hostname)
      || !/^\/point_fantasy_lineups_2a_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('Banco local de testes dedicado obrigatorio');
    db = new PrismaClient({ datasources: { db: { url } } });
    service = new LineupService(db as PrismaService);
    user = (await db.usuario.create({data:{email:`${token}@test.invalid`,status:'ATIVO'}})).idUsuario;
    other = (await db.usuario.create({data:{email:`${token}-other@test.invalid`,status:'ATIVO'}})).idUsuario;
    catalog = (await db.fantasyCatalogo.create({data:{temporada:65000,rodada:38,versao:1,capturadoEm:new Date(),status:'CONGELADO',congeladoEm:new Date(),referencias:{}}})).id;
    otherCatalog = (await db.fantasyCatalogo.create({data:{temporada:65000,rodada:38,versao:2,capturadoEm:new Date(),referencias:{}}})).id;
    let externalId=1;
    const add = async (posicaoId:number,categoriaId:number|null,club=10,catalogId=catalog) => (await db.fantasyCatalogoAtleta.create({data:{catalogoId:catalogId,atletaIdExterno:externalId++,clubeIdExterno:club,posicaoId,statusId:7,apelido:'Test fixture',precoCartola:categoriaId===3?'10.00':categoriaId===2?'6.00':'1.00',categoriaId,pointcoins:categoriaId===3?30:categoriaId===2?20:10}})).id;
    for(const pos of [1,2,3,4,5]) { starters[pos]=[];reserves[pos]=[];
      for(let i=0;i<5;i++) starters[pos].push(await add(pos,3));
      for(let i=0;i<2;i++) reserves[pos].push(await add(pos,2));
    }
    coach=await add(6,null);blockedClub=await add(1,3,99);otherSnapshot=await add(1,3,10,otherCatalog);
    competition=(await db.fantasyCompeticao.create({data:{catalogoId:catalog,nome:token,temporada:65000,rodada:38,tipoAcesso:'FREE',valorInscricao:'0.00',status:'PUBLICADA',inicioInscricao:new Date(Date.now()-60000),fimInscricao:new Date(Date.now()+3600000),limiteEscalacoesUsuario:1,partidas:{create:{partidaIdExterno:4000000000,clubeMandanteId:10,clubeVisitanteId:20,inicioPrevisto:new Date(Date.now()+7200000)}}}})).id;
  },30000);
  afterAll(async () => {
    if(!db)return;
    try{
      if(competition){await db.fantasyEscalacao.deleteMany({where:{competicaoId:competition}});await db.fantasyCompeticaoPartida.deleteMany({where:{competicaoId:competition}});await db.fantasyCompeticao.delete({where:{id:competition}});}
      if(catalog||otherCatalog){await db.fantasyCatalogoAtleta.deleteMany({where:{catalogoId:{in:[catalog,otherCatalog].filter(Boolean)}}});await db.fantasyCatalogo.deleteMany({where:{id:{in:[catalog,otherCatalog].filter(Boolean)}}});}
      await db.usuario.deleteMany({where:{idUsuario:{in:[user,other].filter(Boolean)}}});
    }finally{await db.$disconnect();}
  });
  const complete = (formacao='4-3-3') => {
    const titulares=Object.entries(FORMATION_COUNTS[formacao]).flatMap(([pos,count])=>starters[Number(pos)].slice(0,count));
    return {formacao,titulares,tecnico:coach,reservas:[reserves[1][0],reserves[3][0],reserves[4][0],reserves[5][0],FORMATION_COUNTS[formacao][2]?reserves[2][0]:reserves[3][1]],capitaoAtletaId:titulares[0],reservaMagoAtletaId:reserves[1][0]};
  };
  it.each(Object.keys(FORMATION_COUNTS))('persiste e recupera formacao completa %s',async formacao=>{
    const s=await service.create(user,competition,complete(formacao));
    expect(s.validacao.completa).toBe(true);expect(s.atletas).toHaveLength(17);expect(s.status).toBe('RASCUNHO');
    expect((await service.get(user,s.id)).reservaMagoAtletaId).toBe(reserves[1][0]);
  });
  it('rascunhos nao consomem limite de confirmados nem tem efeitos financeiros',async()=>{
    const before=await db.movimentacaoCarteira.count();
    const a=await service.create(user,competition,{formacao:'4-3-3'}),b=await service.create(user,competition,{formacao:'4-4-2'});
    expect(a.validacao.completa).toBe(false);expect(b.id).not.toBe(a.id);
    expect(await db.movimentacaoCarteira.count()).toBe(before);
    expect(await db.inscricaoTimeCompeticao.count()).toBe(0);
  });
  it.each(['clube','catalogo'])('rejeita atleta de outro %s sem criar parcialmente',async kind=>{
    const before=await db.fantasyEscalacao.count();
    await expect(service.create(user,competition,{formacao:'4-3-3',titulares:[kind==='clube'?blockedClub:otherSnapshot]})).rejects.toMatchObject({status:400});
    expect(await db.fantasyEscalacao.count()).toBe(before);
  });
  it('edicao substitui selecao atomicamente e exige versao',async()=>{
    const s=await service.create(user,competition,{formacao:'4-3-3'});
    const saved=await service.update(user,s.id,{versao:1,...complete()});
    expect(saved.versao).toBe(2);expect(saved.validacao.completa).toBe(true);
    await expect(service.update(user,s.id,{versao:1,titulares:[]})).rejects.toMatchObject({status:409});
    await expect(service.update(user,s.id,{versao:2,titulares:[blockedClub]})).rejects.toMatchObject({status:400});
    expect((await service.get(user,s.id)).versao).toBe(2);
  });
  it('duplicacao copia selecao, capitao, mago e formacao com novo ID',async()=>{
    const s=await service.create(user,competition,complete('3-5-2'));
    const copy=await service.duplicate(user,s.id,s.versao);
    expect(copy.id).not.toBe(s.id);expect(copy.competicaoId).toBe(competition);expect(copy.versao).toBe(1);
    for(const key of ['formacao','titulares','tecnico','reservas','capitaoAtletaId','reservaMagoAtletaId'] as const)expect(copy[key]).toEqual(s[key]);
  });
  it('protege leitura, edicao, copia e exclusao contra outro usuario',async()=>{
    const s=await service.create(user,competition,{formacao:'4-3-3'});
    for(const action of [()=>service.get(other,s.id),()=>service.update(other,s.id,{versao:1}),()=>service.duplicate(other,s.id,1),()=>service.remove(other,s.id,1)])await expect(action()).rejects.toMatchObject({status:404});
    expect((await service.list(other,competition,{page:1,limit:100})).total).toBe(0);
    expect((await service.get(user,s.id)).versao).toBe(1);
  });
  it('somente uma edicao concorrente vence',async()=>{
    const s=await service.create(user,competition,{formacao:'4-3-3'});
    const results=await Promise.allSettled([service.update(user,s.id,{versao:1,formacao:'4-4-2'}),service.update(user,s.id,{versao:1,formacao:'5-4-1'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(failure.reason.status).toBe(409);
    expect((await service.get(user,s.id)).versao).toBe(2);
  });
  it('falha posterior a multiplas escritas reverte toda transacao',async()=>{
    const before=await db.fantasyEscalacao.count(),children=await db.fantasyEscalacaoAtleta.count();
    const injected=new Error('INJECTED_ROLLBACK');
    const proxy={$transaction:(action:any,options:any)=>db.$transaction(async tx=>{await action(tx);throw injected;},options)};
    await expect(new LineupService(proxy as unknown as PrismaService).create(user,competition,complete())).rejects.toBe(injected);
    expect(await db.fantasyEscalacao.count()).toBe(before);expect(await db.fantasyEscalacaoAtleta.count()).toBe(children);
  });
  it('exclui rascunho e filhos em cascata',async()=>{
    const s=await service.create(user,competition,complete());await service.remove(user,s.id,1);
    expect(await db.fantasyEscalacaoAtleta.count({where:{escalacaoId:s.id}})).toBe(0);
    await expect(service.get(user,s.id)).rejects.toMatchObject({status:404});
  });
  it('bloqueio temporal vale para criar, editar, duplicar e excluir; leitura permanece',async()=>{
    const s=await service.create(user,competition,{formacao:'4-3-3'});
    const match=await db.fantasyCompeticaoPartida.findFirstOrThrow({where:{competicaoId:competition}});
    await db.fantasyCompeticaoPartida.update({where:{id:match.id},data:{inicioPrevisto:new Date(Date.now()-1000)}});
    try{
      for(const action of [()=>service.create(user,competition,{formacao:'4-3-3'}),()=>service.update(user,s.id,{versao:1}),()=>service.duplicate(user,s.id,1),()=>service.remove(user,s.id,1)])await expect(action()).rejects.toMatchObject({status:409});
      expect((await service.get(user,s.id)).id).toBe(s.id);
    }finally{await db.fantasyCompeticaoPartida.update({where:{id:match.id},data:{inicioPrevisto:match.inicioPrevisto}});}
  });
  it('FK e unicidade de atleta sao aplicadas no MySQL',async()=>{
    const s=await service.create(user,competition,complete());
    await expect(db.fantasyEscalacaoAtleta.create({data:{escalacaoId:s.id,catalogoAtletaId:s.titulares[0],papel:'RESERVA'}})).rejects.toMatchObject({code:'P2002'});
    await expect(db.fantasyEscalacaoAtleta.create({data:{escalacaoId:s.id,catalogoAtletaId:4294967295,papel:'RESERVA'}})).rejects.toMatchObject({code:'P2003'});
  });
});
