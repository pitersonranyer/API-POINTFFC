import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';
import { FORMATION_COUNTS } from '../src/point-fantasy/lineups/lineup.rules';
import * as teamIdentity from '../src/point-fantasy/lineups/team-identity';

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
  const extraUsers: number[] = [];
  const freshUser = async () => {
    const row = await db.usuario.create({ data: { email: `${token}-${extraUsers.length}@test.invalid`, status: 'ATIVO' } });
    extraUsers.push(row.idUsuario);
    return row.idUsuario;
  };
  afterEach(() => jest.restoreAllMocks());
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
      if(competition){await db.fantasyEscalacao.deleteMany({where:{competicaoId:competition}});await db.fantasyInscricaoOperacao.deleteMany({where:{competicaoId:competition}});await db.fantasyTimeOperacao.deleteMany({where:{identidade:{competicaoId:competition}}});await db.fantasyTimeIdentidade.deleteMany({where:{competicaoId:competition}});await db.fantasyCompeticaoPartida.deleteMany({where:{competicaoId:competition}});await db.fantasyCompeticao.delete({where:{id:competition}});}
      if(catalog||otherCatalog){await db.fantasyCatalogoAtleta.deleteMany({where:{catalogoId:{in:[catalog,otherCatalog].filter(Boolean)}}});await db.fantasyCatalogo.deleteMany({where:{id:{in:[catalog,otherCatalog].filter(Boolean)}}});}
      await db.usuario.deleteMany({where:{idUsuario:{in:[user,other,...extraUsers].filter(Boolean)}}});
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
  it('first-save rollback does not retain an identity', async () => {
    const injected = new Error('FIRST_SAVE_ROLLBACK');
    const proxy = { $transaction: (action: any, options: any) => db.$transaction(async tx => { await action(tx); throw injected; }, options) };
    await expect(new LineupService(proxy as unknown as PrismaService).create(other, competition,
      { formacao: '4-3-3', nomeBase: 'Primeiro', chaveIdempotencia: 'rollback' })).rejects.toBe(injected);
    expect(await db.fantasyTimeIdentidade.count({ where: { usuarioId: other, competicaoId: competition } })).toBe(0);
  });
  it('concurrent first saves create one identity; retries do not allocate twice', async () => {
    const dto = { formacao: '4-3-3', nomeBase: 'Concorrente', chaveIdempotencia: 'first' };
    const results = await Promise.allSettled([service.create(other, competition, dto), service.create(other, competition, dto)]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.status).toBe(409);
    const replay = await service.create(other, competition, dto);
    expect(replay.sequencial).toBe(1);
    expect(await db.fantasyTimeIdentidade.count({ where: { usuarioId: other, competicaoId: competition } })).toBe(1);
    expect(await db.fantasyEscalacao.count({ where: { usuarioId: other, competicaoId: competition } })).toBe(1);
  });
  it('simultaneous create and duplicate allocate distinct monotonically increasing numbers', async () => {
    const source = (await service.list(other, competition, { page: 1, limit: 50 })).items[0];
    const create = () => service.create(other, competition, { formacao: '4-3-3', chaveIdempotencia: 'parallel-create' });
    const duplicate = () => service.duplicate(other, source.id, source.versao, { chaveIdempotencia: 'parallel-copy' });
    const results = await Promise.allSettled([create(), duplicate()]);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.status).toBe(409);
    const a = await create(), b = await duplicate();
    expect([a.sequencial, b.sequencial].sort()).toEqual([2, 3]);
    const identity = await db.fantasyTimeIdentidade.findUniqueOrThrow({ where: { usuarioId_competicaoId: { usuarioId: other, competicaoId: competition } } });
    expect(identity.ultimoSequencial).toBe(3);
    await expect(db.fantasyTimeIdentidade.create({ data: { usuarioId: other, competicaoId: competition,
      nomeBase: 'Duplicate', identificadorPublico: 'AAAAAAA' } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.fantasyEscalacao.create({ data: { usuarioId: other, competicaoId: competition,
      formacao: '4-3-3', nomePublico: a.nomePublico } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.fantasyEscalacao.create({ data: { usuarioId: other, competicaoId: competition,
      formacao: '4-3-3', identidadeId: identity.id, sequencial: a.sequencial, nomePublico: 'different' } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.fantasyEscalacao.create({ data: { usuarioId: user, competicaoId: competition,
      formacao: '4-3-3', identidadeId: identity.id, sequencial: 90, nomePublico: 'forged-owner' } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('two unkeyed first saves keep one identity and distinct sequences', async () => {
    const owner = await freshUser();
    const dto = { formacao: '4-3-3', nomeBase: 'Original' };
    const results = await Promise.allSettled([service.create(owner, competition, dto), service.create(owner, competition, dto)]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.status).toBe(409);
    const list = await service.list(owner, competition, { page: 1, limit: 50 });
    expect(new Set(list.items.map(i => i.sequencial)).size).toBe(list.total);
    expect(list.identidade?.ultimoSequencial).toBe(list.total);
    expect(await db.fantasyTimeIdentidade.count({ where: { usuarioId: owner, competicaoId: competition } })).toBe(1);
  });
  it.each(['create', 'duplicate'])('concurrent %s requests retain distinct sequences and idempotency', async kind => {
    const owner = await freshUser();
    const source = await service.create(owner, competition, { formacao: '4-3-3', nomeBase: 'Estavel' });
    const action = (key: string) => kind === 'create'
      ? service.create(owner, competition, { formacao: '4-3-3', chaveIdempotencia: key })
      : service.duplicate(owner, source.id, source.versao, { chaveIdempotencia: key });
    const results = await Promise.allSettled([action('a'), action('b')]);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.status).toBe(409);
    const a = await action('a'), b = await action('b');
    expect([a.sequencial, b.sequencial].sort()).toEqual([2, 3]);
    expect(a.identidade?.identificadorPublico).toBe(source.identidade?.identificadorPublico);
    const before = await service.list(owner, competition, { page: 1, limit: 50 });
    await expect(service.create(owner, competition, { formacao: '4-4-2', chaveIdempotencia: 'a' })).rejects.toMatchObject({ status: 409 });
    await expect(service.create(owner, competition, { formacao: '4-3-3', nomeBase: 'Renomeado' })).rejects.toMatchObject({ status: 409 });
    expect((await service.list(owner, competition, { page: 1, limit: 50 })).identidade).toEqual(before.identidade);
    for (const item of before.items) await service.remove(owner, item.id, item.versao);
    expect(await service.list(owner, competition, { page: 1, limit: 50 })).toMatchObject({ total: 0, estadoIdentidade: 'DEFINIDA' });
    const next = await service.create(owner, competition, { formacao: '4-3-3' });
    expect(next.sequencial).toBe(4);
    expect(next.identidade?.identificadorPublico).toBe(source.identidade?.identificadorPublico);
  });
  it('real public-code collision retries without changing the previous identity', async () => {
    const owner = await freshUser(), nextOwner = await freshUser();
    const code = teamIdentity.generatePublicTeamCode();
    const generate = jest.spyOn(teamIdentity, 'generatePublicTeamCode').mockReturnValue(code);
    const existing = await service.create(owner, competition, { formacao: '4-3-3', nomeBase: 'Anterior' });
    const nextCode = code === 'BBBBBBB' ? 'CCCCCCC' : 'BBBBBBB';
    generate.mockReturnValueOnce(code).mockReturnValue(nextCode);
    const saved = await service.create(nextOwner, competition, { formacao: '4-3-3', nomeBase: 'Solicitado' });
    expect(saved).toMatchObject({ sequencial: 1, identidade: { nomeBase: 'Solicitado', identificadorPublico: nextCode } });
    expect((await service.get(owner, existing.id)).identidade?.identificadorPublico).toBe(code);
    generate.mockReturnValue(code);
    const exhaustedOwner = await freshUser();
    await expect(service.create(exhaustedOwner, competition, { formacao: '4-3-3' })).rejects.toMatchObject({ status: 409 });
    expect(await db.fantasyTimeIdentidade.count({ where: { usuarioId: exhaustedOwner, competicaoId: competition } })).toBe(0);
  });
  it('first save persists the chosen name, a seven-character code and sequence 01', async () => {
    const owner = await freshUser();
    const saved = await service.create(owner, competition, { formacao: '4-3-3', nomeBase: 'Tropa do Mago', chaveIdempotencia: 'initial' });
    expect(saved.identidade?.identificadorPublico).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);
    expect(saved).toMatchObject({ sequencial: 1, legado: false, identidade: { nomeBase: 'Tropa do Mago', ultimoSequencial: 1 } });
    expect(saved.nomePublico).toBe('#' + saved.identidade!.identificadorPublico + ' \u00b7 Tropa do Mago 01');
    expect(await service.get(owner, saved.id)).toMatchObject({ nomePublico: saved.nomePublico, sequencial: 1 });
  });
  it('legacy drafts remain unnamed through read, update and duplication', async () => {
    const owner = await freshUser();
    const legacy = await db.fantasyEscalacao.create({ data: { usuarioId: owner, competicaoId: competition, formacao: '4-3-3' } });
    expect(await service.list(owner, competition, { page: 1, limit: 50 })).toMatchObject({ estadoIdentidade: 'LEGADO', rascunhosLegados: 1 });
    expect(await service.get(owner, legacy.id)).toMatchObject({ legado: true, nomePublico: null, sequencial: null, identidade: null });
    const edited = await service.update(owner, legacy.id, { versao: 1, formacao: '4-4-2' });
    expect(edited).toMatchObject({ legado: true, versao: 2, nomePublico: null });
    const copy = await service.duplicate(owner, legacy.id, edited.versao, { nomeBase: 'Novo nome', chaveIdempotencia: 'legacy-copy' });
    expect(copy).toMatchObject({ legado: false, sequencial: 1, formacao: '4-4-2', identidade: { nomeBase: 'Novo nome' } });
    expect(await service.get(owner, legacy.id)).toMatchObject({ legado: true, nomePublico: null, sequencial: null });
    expect(await service.list(owner, competition, { page: 1, limit: 50 })).toMatchObject({ estadoIdentidade: 'DEFINIDA', rascunhosLegados: 1, total: 2 });
  });
  it('FREE confirmation serializes concurrent requests, preserves identity and blocks mutations without financial effects', async () => {
    const owner = await freshUser();
    const a = await service.create(owner, competition, complete());
    const b = await service.create(owner, competition, complete());
    const identityBefore = (await service.get(owner, a.id)).identidade;
    const financialBefore = await db.movimentacaoCarteira.count();
    const request = (id: number, key: string) => service.confirmFree(owner, competition, { escalacaoIds: [id], chaveIdempotencia: key });
    const results = await Promise.allSettled([request(a.id, 'race-a'), request(b.id, 'race-b')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.fantasyEscalacao.count({ where: { usuarioId: owner, competicaoId: competition, status: 'INSCRITA' } })).toBe(1);
    const index = results.findIndex(r => r.status === 'fulfilled');
    const winner = index === 0 ? a : b;
    const result = (results[index] as PromiseFulfilledResult<unknown>).value;
    expect(await request(winner.id, index === 0 ? 'race-a' : 'race-b')).toEqual(result);
    const saved = await service.get(owner, winner.id);
    expect(saved).toMatchObject({ status: 'INSCRITA', nomePublico: winner.nomePublico, sequencial: winner.sequencial, identidade: identityBefore, confirmadaEm: expect.any(Date) });
    await expect(service.update(owner, winner.id, { versao: saved.versao })).rejects.toThrow();
    await expect(service.remove(owner, winner.id, saved.versao)).rejects.toThrow();
    await expect(service.duplicate(owner, winner.id, saved.versao)).rejects.toThrow();
    expect(await db.movimentacaoCarteira.count()).toBe(financialBefore);
  });
  it('FREE rejects an incomplete batch without registering its valid draft', async () => {
    const owner = await freshUser();
    const valid = await service.create(owner, competition, complete());
    const incomplete = await service.create(owner, competition, { formacao: '4-3-3' });
    const before = await service.get(owner, valid.id);
    await expect(service.confirmFree(owner, competition, { escalacaoIds: [valid.id, incomplete.id], chaveIdempotencia: 'invalid-batch' })).rejects.toThrow('incompleta');
    expect(await service.get(owner, valid.id)).toEqual(before);
    expect((await service.get(owner, incomplete.id)).status).toBe('RASCUNHO');
    expect(await db.fantasyInscricaoOperacao.count({ where: { usuarioId: owner } })).toBe(0);
  });
  it('FREE reloads eligibility from persisted athletes and rejects a foreign club', async () => {
    const owner = await freshUser();
    const draft = await service.create(owner, competition, complete());
    const goalkeeper = draft.atletas.find(a => a.papel === 'TITULAR' && a.atleta.posicaoId === 1)!;
    await db.fantasyEscalacaoAtleta.updateMany({ where: { escalacaoId: draft.id, catalogoAtletaId: goalkeeper.catalogoAtletaId }, data: { catalogoAtletaId: blockedClub } });
    await expect(service.confirmFree(owner, competition, { escalacaoIds: [draft.id], chaveIdempotencia: 'ineligible' })).rejects.toThrow('fora do catalogo');
    expect((await db.fantasyEscalacao.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('RASCUNHO');
    expect(await db.fantasyInscricaoOperacao.count({ where: { usuarioId: owner } })).toBe(0);
  });
  it('FREE counts previous confirmations, rejects a new key for an enrolled team and preserves remaining drafts', async () => {
    const owner = await freshUser();
    const a = await service.create(owner, competition, complete());
    const b = await service.create(owner, competition, complete());
    await service.confirmFree(owner, competition, { escalacaoIds: [a.id], chaveIdempotencia: 'first' });
    await expect(service.confirmFree(owner, competition, { escalacaoIds: [b.id], chaveIdempotencia: 'over-limit' })).rejects.toThrow('Limite');
    await expect(service.confirmFree(owner, competition, { escalacaoIds: [a.id], chaveIdempotencia: 'already-enrolled' })).rejects.toThrow('indisponivel');
    expect(await service.get(owner, b.id)).toEqual(b);
    expect(await db.fantasyInscricaoOperacao.count({ where: { usuarioId: owner } })).toBe(1);
    const own = await service.list(owner, competition, { page: 1, limit: 50 });
    expect(own.items.find(item => item.id === a.id)).toMatchObject({ status: 'INSCRITA', confirmadaEm: expect.any(Date) });
    expect(own.items.find(item => item.id === b.id)).toMatchObject({ status: 'RASCUNHO', confirmadaEm: null });
  });
  it('MySQL enforces registration state consistency and operation ownership', async () => {
    const owner = await freshUser(), otherOwner = await freshUser();
    const a = await service.create(owner, competition, complete());
    const b = await service.create(otherOwner, competition, complete());
    await expect(db.fantasyEscalacao.update({ where: { id: b.id }, data: { status: 'INSCRITA' } })).rejects.toThrow();
    await service.confirmFree(owner, competition, { escalacaoIds: [a.id], chaveIdempotencia: 'constraint-owner' });
    const saved = await db.fantasyEscalacao.findUniqueOrThrow({ where: { id: a.id } });
    await expect(db.fantasyEscalacao.update({ where: { id: b.id }, data: {
      status: 'INSCRITA', confirmadaEm: saved.confirmadaEm, inscricaoOperacaoId: saved.inscricaoOperacaoId,
    } })).rejects.toThrow();
    expect((await service.get(otherOwner, b.id)).status).toBe('RASCUNHO');
  });
  it('concurrent confirmations with the same key return one durable result', async () => {
    const owner = await freshUser();
    const draft = await service.create(owner, competition, complete());
    const dto = { escalacaoIds: [draft.id], chaveIdempotencia: 'same-key-race' };
    const results = await Promise.allSettled([service.confirmFree(owner, competition, dto), service.confirmFree(owner, competition, dto)]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    const replay = await service.confirmFree(owner, competition, dto);
    for (const result of results) {
      if (result.status === 'fulfilled') expect(result.value).toEqual(replay);
      else expect(result.reason).toMatchObject({ status: 409 });
    }
    expect(await db.fantasyInscricaoOperacao.count({ where: { usuarioId: owner, competicaoId: competition } })).toBe(1);
    expect(await db.fantasyEscalacao.count({ where: { usuarioId: owner, status: 'INSCRITA' } })).toBe(1);
  });
  it('FREE batch and durable idempotency roll back on a real persistence failure', async () => {
    const owner = await freshUser();
    const a = await service.create(owner, competition, complete());
    const b = await service.create(owner, competition, complete());
    await db.fantasyCompeticao.update({ where: { id: competition }, data: { limiteEscalacoesUsuario: 2 } });
    try {
      const original = db.$transaction.bind(db);
      const spy = jest.spyOn(db, '$transaction').mockImplementationOnce((async (action: any, options: any) => original(async tx => {
        const update = tx.fantasyEscalacao.updateMany.bind(tx.fantasyEscalacao);
        let writes = 0;
        tx.fantasyEscalacao.updateMany = (async (args: any) => {
          if (++writes === 2) throw new Error('Injected persistence failure');
          return update(args);
        }) as typeof update;
        return action(tx);
      }, options)) as any);
      const dto = { escalacaoIds: [a.id, b.id], chaveIdempotencia: 'atomic-batch' };
      await expect(service.confirmFree(owner, competition, dto)).rejects.toThrow('Injected persistence failure');
      spy.mockRestore();
      expect(await db.fantasyEscalacao.count({ where: { usuarioId: owner, status: 'INSCRITA' } })).toBe(0);
      expect(await db.fantasyInscricaoOperacao.count({ where: { usuarioId: owner } })).toBe(0);
      const result = await service.confirmFree(owner, competition, dto);
      expect(result).toMatchObject({ quantidadeConfirmada: 2, valorTotal: '0.00' });
      expect(await service.confirmFree(owner, competition, { ...dto, escalacaoIds: [b.id, a.id] })).toEqual(result);
      await expect(service.confirmFree(owner, competition, { ...dto, escalacaoIds: [a.id] })).rejects.toThrow('parametros diferentes');
    } finally {
      jest.restoreAllMocks();
      await db.fantasyCompeticao.update({ where: { id: competition }, data: { limiteEscalacoesUsuario: 1 } });
    }
  });
});
