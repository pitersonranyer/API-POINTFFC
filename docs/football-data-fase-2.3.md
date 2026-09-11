# Futebol — Fase 2.3: sincronização automática BSA

## Arquitetura e persistência

AppModule registra ScheduleModule.forRoot() e FutebolSchedulerModule. O cron avalia
a cada cinco minutos (segundo zero), consultando apenas MySQL antes de decidir.
FutebolSchedulerService chama exclusivamente FutebolSyncService.syncBrasileirao().
O módulo de leitura e os quatro GETs continuam independentes, DB-only.
O comando manual continua funcionando. Client, normalização, upserts, nomes,
nomeOriginal e vínculo Cartola por EXTERNAL_ID são os mesmos; nenhum acesso novo ao Cartola.
@nestjs/schedule 4.1.2 declara compatibilidade com Nest 10 nas peerDependencies.
Referência: https://docs.nestjs.com/techniques/task-scheduling

A migration 0016_futebol_ultimo_sync adiciona FUTEBOL_COMPETICAO.ULTIMO_SYNC_EM,
nullable DATETIME(3). ATUALIZADO_EM indica alteração do registro; ULTIMA_ATUALIZACAO_API
indica atualização no provedor. Nenhum deles significa sucesso de uma carga completa.
O novo campo registra, em UTC, o início da última execução que concluiu com sucesso.
É escrito na mesma transação serializável dos dados: qualquer erro/rollback preserva
o valor anterior. Tanto o comando manual quanto a automação atualizam esse campo.
Usar o início é conservador: uma carga que atravessa uma janela não a dá por coberta.

## Startup e periodicidades

Com a flag habilitada, onApplicationBootstrap inicia uma avaliação em segundo plano,
sem bloquear a prontidão HTTP. Sem BSA ou sem partidas na temporada atual, faz carga
inicial. Registro sem histórico faz reconciliação. Base atual não chama o provedor;
base atrasada recupera a última janela vencida, sem repetir todas as janelas perdidas.

| Situação | Política |
| --- | --- |
| Sem jogos/atividade | 06:00 e 18:00 em America/Sao_Paulo |
| Jogo futuro no dia, distante mais de 1h | intervalo mínimo de 60 minutos |
| TIMED/SCHEDULED começando em até 1h | intervalo mínimo de 10 minutos |
| IN_PLAY ou PAUSED | intervalo mínimo de 5 minutos |
| TIMED/SCHEDULED com início já atingido | 5 minutos enquanto início <= agora < início + 3h |
| Reconciliação final | primeiro tick elegível após último início do dia + 3h; mínimo 5 minutos desde último sucesso |

Os intervalos são mínimos; a execução ocorre no próximo tick de cinco minutos.
Jogos próximos ou em andamento atravessando meia-noite continuam sendo considerados.
Depois da janela conservadora de três horas, o timestamp de sucesso marca a
reconciliação final como atendida, inclusive quando o provedor mantém TIMED/SCHEDULED.
Em seguida valem as janelas 06h/18h. FINISHED também recebe essa reconciliação
conservadora, não necessariamente imediatamente ao apito final.
Dias anteriores são considerados para recuperar reconciliações perdidas em restarts.
IN_PLAY/PAUSED persistentes têm prioridade e continuam a cada cinco minutos até o
provedor informar o encerramento; não se presume encerrado um status explicitamente live.

Intl.DateTimeFormat usa explicitamente a zona IANA America/Sao_Paulo para dias e
resolução das janelas. O cron também declara essa zona. Não depende de TZ do Render
e não altera a persistência UTC. Antes de 06h, a última janela é 18h do dia anterior.

## Falhas, concorrência e flag

FUTEBOL_SYNC_SCHEDULER_ENABLED=true habilita startup e cron. false/ausente desabilita
ambos, inclusive as consultas do scheduler ao banco. A validação Joi tem default false;
o serviço aceita apenas boolean true ou string literal 'true'. .env.example é seguro.
Os testes usam mocks e relógio controlado, sem chamar football-data real.

Um lock em memória com try/finally protege desde a consulta ao banco até o fim do sync,
contra startup + cron e cron + cron. O sync mantém seu próprio compartilhamento de
Promise. Não é lock distribuído: múltiplas réplicas/processos ou CLI separado podem
consultar o provedor simultaneamente. Executar apenas uma instância com a flag ligada.

Falhas de banco/provedor são capturadas, geram aviso sanitizado e liberam o lock.
Nova tentativa respeita cooldown em memória do intervalo da política (mínimo 5min);
o timestamp persistente só muda em sucesso. Cooldown não sobrevive ao restart.
Não há Redis, fila, worker, endpoint administrativo ou sync no Start Command.

## Configuração exata no Render

1. Publicar esta versão. Build Command: `npm ci && npm run build`.
   O fluxo existente em src/main.ts já executa deployMigrations() antes de criar
   a aplicação quando NODE_ENV=production. Ele aplica `prisma migrate deploy`,
   incluindo a nova migration, sem Shell. Esse fluxo foi preservado.
   DATABASE_URL precisa permitir conexão e ALTER TABLE. Falha de migration
   impede startup, conforme o comportamento preexistente; falha do provedor não.
2. Environment: `NODE_ENV=production`, `FUTEBOL_SYNC_SCHEDULER_ENABLED=true`,
   `FOOTBALL_DATA_API_TOKEN=<token football-data com acesso BSA>` e
   `DATABASE_URL=<URL MySQL de produção>`. Manter as demais variáveis existentes.
3. Start Command permanece `npm run start:prod` (ou o atual equivalente `node dist/main`).
4. Fazer deploy/restart. Não é preciso Shell nem Render Cron Job. Não há necessidade de TZ.

Não é necessário configurar Pre-Deploy nesta arquitetura. Se a equipe preferir
aplicar migrations antecipadamente, o comando é `npx prisma migrate deploy`;
o recurso do Render está descrito em https://render.com/docs/deploys.

Migration criada, mas não aplicada ao banco local nem à produção nesta entrega.
A primeira carga pode ainda estar em andamento quando o HTTP ficar disponível;
nesse intervalo, GETs podem responder vazio/404 conforme o contrato existente.

## Validação da carga em produção

Nos logs, procurar `BSA sync iniciado: carga-inicial` e depois `BSA sync concluido`
com `clubesProcessados:20`, `partidasRecebidas:380`, `partidasPersistidas:380`.
Consultar `GET /futebol/competicoes` para descobrir temporadaAtual e
`GET /futebol/competicoes/BSA/jogos?temporada=2026` (substituir pela temporada informada).
Esperado: total=380 e 20 externalId distintos na união de mandante e visitante.
Conferir cartolaClubeId, nomes amigáveis e nomeOriginal nos dados/contratos existentes.
Para conferência MySQL por um cliente autorizado:

```sql
SELECT CODIGO, TEMPORADA_ATUAL, ULTIMO_SYNC_EM
FROM FUTEBOL_COMPETICAO WHERE CODIGO = 'BSA';

SELECT COUNT(*) AS partidas
FROM FUTEBOL_PARTIDA p JOIN FUTEBOL_COMPETICAO c ON c.ID = p.COMPETICAO_ID
WHERE c.CODIGO = 'BSA' AND p.TEMPORADA = c.TEMPORADA_ATUAL;

SELECT COUNT(DISTINCT clube) AS clubes FROM (
  SELECT p.TIME_MANDANTE_ID AS clube
  FROM FUTEBOL_PARTIDA p JOIN FUTEBOL_COMPETICAO c ON c.ID = p.COMPETICAO_ID
  WHERE c.CODIGO = 'BSA' AND p.TEMPORADA = c.TEMPORADA_ATUAL
  UNION
  SELECT p.TIME_VISITANTE_ID AS clube
  FROM FUTEBOL_PARTIDA p JOIN FUTEBOL_COMPETICAO c ON c.ID = p.COMPETICAO_ID
  WHERE c.CODIGO = 'BSA' AND p.TEMPORADA = c.TEMPORADA_ATUAL
) times_temporada;
```

As quantidades dependem da resposta do provedor, como no sync existente; não se
fabricam clubes/partidas nem se rejeita uma resposta válida só pela contagem.
Cada sync faz as três consultas existentes (competição, times e partidas).
Com a instância suspensa/desligada não há cron; a reconciliação ocorre ao reiniciar.
Dados locais atrasados podem atrasar a detecção de jogos recém-remarcados até a
próxima janela; esse é o custo da política de economia de chamadas solicitada.

## Arquivos

Criados: futebol-scheduler.module.ts, futebol-scheduler.service.ts,
futebol-sync-policy.ts, test/futebol-scheduler.spec.ts, migration 0016 e este documento.
Alterados: app.module.ts, futebol-sync.service.ts, environment.validation.ts,
schema.prisma, .env.example, package.json, package-lock.json e test/futebol.spec.ts.

## Validação executada

- Futebol: 149 aprovados, 1 integração MySQL ignorada por flag, 4 suítes aprovadas.
  Inclui 28 novos cenários do scheduler/política e 1 teste novo do timestamp do sync.
- Suíte completa: 641 aprovados, 25 ignorados, 38 suítes aprovadas; executada antes
  da adição do último teste do timestamp, validado depois na suíte Futebol.
- Testes usam fake timers e mocks. GETs DB-only, idempotência, nomes e cartolaClubeId
  continuam cobertos pelos testes existentes de Futebol.
- Build aprovado (Prisma Client + Nest).
- Lint da entrega aprovado. Lint global: somente erro preexistente de `_id` sem uso
  em test/recarga-pix.integration.spec.ts:68, preservado fora do escopo.
- git diff --check aprovado.
- Não foi executado sync real, deploy ou migração de banco nesta entrega.
