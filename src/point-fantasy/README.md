# POINT FFC Fantasy — fundação 1A e 1B

Implementação independente em `src/point-fantasy`, branch `codex/point-fantasy-foundation`.
Não inclui escalações, pontuação, substituições, inscrições, cobrança, carteira ou orçamento de POINTCOINS.

## Auditoria anterior à implementação

- Prisma 5.22 / MySQL: mapeamentos de tabelas e colunas em maiúsculas, IDs de negócio `Int @db.UnsignedInt`, valores `Decimal(12,2)`, migrations 0001–0023. Algumas tabelas legadas têm IDs string; permanecem intactas. As quatro novas tabelas usam exclusivamente PKs e FKs numéricas unsigned.
- `CartolaService` / `CartolaHttpClient` / `CartolaCacheService`: cliente já configura URL e timeout via ConfigService; cache admite fallback stale. Reutilizados, adicionando somente `loadMarketAthletesFresh()` ao service existente.
- Endpoints existentes em `/cartola`: `/mercado/status`, `/atletas/mercado`, `/clubes`, `/partidas`, `/partidas/:rodada`. Não alterados.
- Competições Cartola (`Liga`, `LigaModalidade`, `CompeticaoLiga`) e desafios são domínios separados. Não há FK nova para esses modelos, usuários, carteira nem API-Football.
- JWT e `AdminGuard` existentes exigem PLATFORM_ADMIN ATIVO. AuthModule é importado sem mudar autenticação.
- Validação global: whitelist, forbidNonWhitelisted e transform. Testes Jest/ts-jest em `test/`, ESLint e TypeScript strict; integração MySQL normalmente opt-in.
- Nenhum AGENTS.md encontrado no repositório. Três testes athlete-history não rastreados já estavam presentes e foram preservados.

## Evidência da fonte real (consulta somente leitura em 15/10/2026)

`/mercado/status`: temporada 2026, rodada_atual 31, status_mercado 1, bola_rolando false.
`/atletas/mercado`: objetos clubes, posicoes, status e array atletas. Atleta observado com rodada_id 30, preco_num 4.79, clube_id 282, posicao_id 3. Portanto rodada_id NÃO é usado como rodada do catálogo. Dicionário confirma posição 6, abreviação `tec`.
`/partidas`: rodada 31; IDs numéricos de partida/clubes e timestamp em segundos. `partida_data` não possui offset; a implementação usa timestamp para evitar dependência do fuso do servidor. Não presume temporada adicional no payload de atletas ou partidas.

## Modelo físico

Todas as PKs: `ID INT UNSIGNED AUTO_INCREMENT`. Todas as FKs: `INT UNSIGNED`, `ON DELETE RESTRICT`.

| Tabela | Conteúdo e restrições |
| --- | --- |
| FANTASY_CATALOGO | TEMPORADA SMALLINT UNSIGNED, RODADA TINYINT UNSIGNED, VERSAO INT UNSIGNED; UNIQUE(TEMPORADA, RODADA, VERSAO); STATUS VARCHAR(20); CAPTURADO_EM, CONGELADO_EM nullable, CRIADO_EM DATETIME(3); REFERENCIAS JSON |
| FANTASY_CATALOGO_ATLETA | CATALOGO_ID FK; ATLETA_ID_EXTERNO, CLUBE_ID_EXTERNO, POSICAO_ID, STATUS_ID INT UNSIGNED; APELIDO VARCHAR(255); PRECO_CARTOLA DECIMAL(12,2); CATEGORIA_ID TINYINT UNSIGNED nullable; POINTCOINS SMALLINT UNSIGNED; UNIQUE(CATALOGO_ID, ATLETA_ID_EXTERNO); índice de catálogo/clube/ID |
| FANTASY_COMPETICAO | CATALOGO_ID FK; NOME VARCHAR(255); TEMPORADA SMALLINT UNSIGNED, RODADA TINYINT UNSIGNED; TIPO_ACESSO ENUM(FREE,PAGO); VALOR_INSCRICAO DECIMAL(12,2); STATUS VARCHAR(30); INICIO_INSCRICAO, FIM_INSCRICAO, CRIADO_EM, ATUALIZADO_EM DATETIME(3); FECHAMENTO_DEFINITIVO_EM DATETIME(3) nullable; LIMITE_ESCALACOES_USUARIO INT UNSIGNED nullable |
| FANTASY_COMPETICAO_PARTIDA | COMPETICAO_ID FK; PARTIDA_ID_EXTERNO, CLUBE_MANDANTE_ID, CLUBE_VISITANTE_ID INT UNSIGNED; INICIO_PREVISTO DATETIME(3), INICIO_REAL DATETIME(3) nullable; STATUS VARCHAR(30); UNIQUE(COMPETICAO_ID, PARTIDA_ID_EXTERNO) |

REFERENCIAS guarda os dicionários originais de clubes/posições e partidas normalizadas do snapshot. Isso evita consultar dados atuais para representar versões antigas. IDs externos Cartola são referências ao provedor, sem FK artificial a tabelas de outro provedor. CATEGORIA_ID é código numérico fixo: 1 Bronze (0–5.99, 10 POINTCOINS), 2 Prata (6–9.99, 20), 3 Ouro (>=10, 30). Técnico: null e 10 POINTCOINS. CHECKs na migration reforçam classificação, status do catálogo, período e preço de acesso.

## Captura, congelamento e concorrência

POST de captura exige temporada/rodada/versão explícitas. A mesma tripla retorna o catálogo existente, inclusive congelado, sem nova leitura nem escrita. Para nova captura, o administrador escolhe uma versão inédita. UNIQUE e transação Serializable impedem duplicações parciais; disputa de unicidade/deadlock retorna 409 e pode ser repetida com o mesmo corpo.

São feitas leituras sem cache: status antes, atletas e partidas, status depois. Ambos os status devem indicar temporada/rodada solicitadas, mercado aberto, bola parada e temporada não encerrada. Payload inválido, preços negativos, IDs duplicados/desconhecidos, partidas sem timestamp ou fora da temporada impedem persistência. Não há fallback para cache antigo.

Todos os snapshots de atletas/referências são imutáveis pela API, mesmo antes de congelar: não existem rotas de edição/exclusão. O congelamento só altera status e timestamp e é idempotente. Criar competição congela automaticamente o catálogo na mesma transação; partidas vêm exclusivamente do snapshot. SQL manual com credenciais de escrita continua fora da proteção da API; não há triggers de imutabilidade.

Competições começam em RASCUNHO. Publicação exige catálogo congelado, partidas e janela futura válida. Consultas públicas expõem somente PUBLICADA. Cada competição filtra atletas no banco pelo catálogo e pela união dos clubes das próprias partidas, incluindo técnicos. Atletas de todos os status Cartola desses clubes permanecem elegíveis nesta fase; não foi inventada restrição por provável/lesionado.

## Endpoints e contratos

GET públicos:

- `/point-fantasy/catalogos`
- `/point-fantasy/catalogos/:id/atletas`
- `/point-fantasy/catalogos/:id/clubes`
- `/point-fantasy/catalogos/:id/posicoes`
- `/point-fantasy/competicoes`
- `/point-fantasy/competicoes/:id`
- `/point-fantasy/competicoes/:id/partidas`
- `/point-fantasy/competicoes/:id/atletas` (elegíveis)

Listas de catálogos/atletas/competições: `{ items: T[], total: number, page: number, limit: number }`. Query `page` default 1, `limit` default 50, máximo 100. Ordenação determinística. Catálogos na listagem não incluem REFERENCIAS.
Clubes/posições: `{ items: [{ id: number, dados: objetoOriginalCartola }] }`, apenas IDs presentes nos atletas do snapshot. Partidas: `{ items: FantasyCompeticaoPartida[] }`. Detalhe: `FantasyCompeticao & { partidas: FantasyCompeticaoPartida[] }`.

POST administrativos (Bearer JWT obrigatório; PLATFORM_ADMIN ATIVO):

- `/admin/point-fantasy/catalogos/capturar`: `{ temporada: 2026, rodada: 31, versao: 1 }` → FantasyCatalogo (inclui REFERENCIAS).
- `/admin/point-fantasy/catalogos/:id/congelar`: sem corpo → FantasyCatalogo.
- `/admin/point-fantasy/competicoes`: `{ catalogoId: 1, nome: "Fantasy Sábado", tipoAcesso: "FREE", valorInscricao: "0.00", inicioInscricao: "2026-10-15T12:00:00-03:00", fimInscricao: "2026-10-16T19:00:00-03:00", partidaIds: [346529], limiteEscalacoesUsuario: 1 }` → competição com partidas. IDs são ilustrativos; use um catálogo/horários válidos no ambiente. Limite é opcional e apenas metadado. TIPO_ACESSO PAGO exige valor positivo; não inicia cobrança.
- `/admin/point-fantasy/competicoes/:id/publicar`: sem corpo → competição com partidas.

GET administrativo `/admin/point-fantasy/competicoes/:id` permite revisar rascunho antes de publicar.

DTOs rejeitam atributos extras; datas exigem ISO com Z ou offset. Valores de entrada usam string decimal com duas casas; campos Decimal nas respostas usam strings JSON do Prisma (sem garantia de zeros finais). Datas retornam ISO UTC. IDs/categorias/POINTCOINS são números. Erros Nest: 400 parâmetros/regras, 401 sem JWT válido, 403 usuário sem acesso, 404 recurso inexistente ou rascunho na API pública, 409 mercado/estado/concorrência, 502 payload/fonte inválida, 503 timeout externo.

## Aplicação controlada da migration

Nenhuma migration foi aplicada por este trabalho. Não iniciar a aplicação em modo production para testar: o bootstrap existente executa `prisma migrate deploy` automaticamente nesse modo.

No PowerShell, configurar explicitamente DATABASE_URL de um banco local/homologação e revisar migrations pendentes antes de aplicar. Não reutilizar URL de produção.

```powershell
$env:DATABASE_URL = 'mysql://usuario:senha@127.0.0.1:3306/point_fantasy_test'
npx.cmd prisma validate
npx.cmd prisma generate
npx.cmd prisma migrate status
npx.cmd prisma migrate deploy
```

A migration 0024 cria somente as quatro tabelas novas e suas restrições. `migrate deploy` também aplica outras migrations pendentes: revisar o status e usar backup antes em ambiente controlado. Requer MySQL 8.0.16+ para CHECKs aplicados.

Integração opt-in, após migrations no banco dedicado:

```powershell
$env:POINT_FANTASY_TEST_DATABASE_URL = $env:DATABASE_URL
npm.cmd test -- --runInBand test/point-fantasy.integration.spec.ts
```

O teste usa exclusivamente POINT_FANTASY_TEST_DATABASE_URL, exige `test` no nome do banco e faz rollback. Não aponta automaticamente para DATABASE_URL. Sem variável, fica skipped.

## Arquivos da entrega

Novos: `src/point-fantasy/{point-fantasy.module.ts,point-fantasy.controller.ts,point-fantasy.dto.ts,point-fantasy.rules.ts,point-fantasy.service.ts,README.md}`, `test/point-fantasy.{service,controller,integration}.spec.ts`, `prisma/migrations/0024_point_fantasy_foundation/migration.sql`.
Modificados: `prisma/schema.prisma` (quatro modelos), `src/app.module.ts` (registro), `src/cartola/cartola.service.ts` (leitura fresca reutilizando cliente).

## Limitações para revisão

- Não há banco de testes explicitamente configurado nesta sessão: execução real da migration/constraints permanece pendente em homologação.
- Provedor não oferece transação atômica entre endpoints: dupla validação detecta transição de mercado, mas não elimina qualquer alteração de preço durante a leitura. Cada snapshot persiste o payload recebido integralmente numa transação.
- Snapshot de partidas mantém horários capturados; reagendamentos exigem nova versão antes de criar outra competição. Não existe sincronização automática nem fechamento automático nesta fase.
- FREE/PAGO e limite de escalações são somente configuração. Não há inscrição ou movimentação financeira.
- Não houve merge, deploy, execução da aplicação ou alteração de produção.

## Validação executada em 15/10/2026

- `npx.cmd prisma generate`: aprovado; cliente Prisma 5.22 gerado localmente.
- `npx.cmd prisma validate`: aprovado.
- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test -- --runInBand --silent`: aprovado, 99 suites e 2.262 testes; 12 suites / 57 testes skipped. Inclui 47 testes novos de regras, captura, concorrência, publicação, isolamento e autorização HTTP. O teste MySQL novo ficou skipped por ausência de POINT_FANTASY_TEST_DATABASE_URL.
- `npm.cmd run build`: aprovado (Prisma generate + Nest build).
- `git diff --check`: aprovado.

Durante a validação, um erro de tipagem na tabela de casos do teste novo foi corrigido e a suíte completa foi executada novamente com sucesso. Um primeiro build encontrou DLL do Prisma bloqueada por processos de testes no Windows; o build completo passou após o término desses processos. Não houve mudança de dependências nem de configuração para contornar esses problemas.

## Fase 2F.1 — consulta pública de inscritos

`GET /point-fantasy/competicoes/:id/ranking?page=1&limit=50` lista somente
escalações INSCRITA, por ID crescente. Paginação ocorre no banco; limite máximo
100, página máxima 1000000. O total conta times, inclusive vários do mesmo dono.

Segue a visibilidade pública existente: somente competição PUBLICADA; inexistente,
rascunho, encerrada ou cancelada retorna 404. Acesso público aos estados encerrada
e cancelada permanece pendente de política explícita.

Autenticação é opcional pelo OptionalJwtAuthGuard. Sem credencial, meuTime é
false; com JWT válido, é calculado pelo proprietário autenticado. Credencial
inválida é rejeitada. usuarioId não é aceito na query nem exposto na resposta.
O cabeçalho é `Cache-Control: private, no-store`.

Resposta: `{ competicaoId, estadoPontuacao, items, total, page, limit }`.
Cada item contém `{ posicao: null, escalacaoId, nomePublico, identidade,
formacao, pontuacao: null, meuTime }`. Identidade contém identificadorPublico,
nomeBase e sequencial; pode ser null nos legados, assim como nomePublico.
Esses dados públicos permitem ao frontend derivar o brasão sem dados pessoais.

NAO_INICIADA exige partidas presentes, todas AGENDADA, sem início real e com
início previsto válido estritamente futuro. Nos demais casos, inclusive no
instante previsto e após o início sem apuração, usa INDISPONIVEL. Não há
pontuação, colocação competitiva nem critério de desempate nesta fase.

A consulta usa um snapshot RepeatableRead para competição, página e total,
com projeção explícita e sem carregar elencos, usuários ou operações financeiras.
Não requer schema ou migration. Desempenho em grande volume deve ser medido
antes de considerar um índice composto adicional.
