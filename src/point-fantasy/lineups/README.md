# POINT FFC Fantasy — Fase 2A: rascunhos de escalação

Branch: `codex/point-fantasy-lineups-phase-2a`, criada a partir da branch foundation com as alterações locais anteriores preservadas. Backend NestJS / Prisma 5.22 / MySQL 8.0.25.

## Auditoria

- Repositório confirmado por origin `pitersonranyer/API-POINTFFC`; nenhum AGENTS.md encontrado.
- Autenticação reutiliza `JwtAuthGuard`, `AuthenticatedUser` e `Usuario.idUsuario` numérico unsigned. O serviço verifica usuário ATIVO; o cliente nunca escolhe o proprietário.
- O módulo novo integra somente `PointFantasyModule`. Nenhuma alteração no `src/fantasy`, autenticação, Cartola, ligas, desafios ou carteira foi necessária nesta fase.
- Preservadas as modificações anteriores em schema/AppModule/CartolaService, os arquivos da fundação e os três testes athlete-history não rastreados.
- Migrations anteriores 0001–0024 mantidas byte a byte, verificadas pelos checksums do banco antes de aplicar a 0025.
- Transações Prisma Serializable e DTOs compatíveis com ValidationPipe global: whitelist, forbidNonWhitelisted, transform. Testes Jest, lint ESLint e TypeScript strict.
- Banco autorizado confirmado: `127.0.0.1:3306/fantasy_point_do_jogador`. Catálogo 3: CONGELADO, 787 atletas; competição 1: PUBLICADA, três partidas. Estes registros não foram alterados.

## Modelo físico

`FANTASY_ESCALACAO`:

- ID INT UNSIGNED AUTO_INCREMENT, PK.
- USUARIO_ID INT UNSIGNED, FK USUARIO.id_usuario, DELETE RESTRICT.
- COMPETICAO_ID INT UNSIGNED, FK FANTASY_COMPETICAO.ID, DELETE RESTRICT.
- FORMACAO VARCHAR(5), CHECK das sete formações.
- STATUS VARCHAR(20), CHECK RASCUNHO. Não existe status de inscrição/confirmada nesta fase.
- VERSAO INT UNSIGNED, default 1, CHECK positivo. Controle de concorrência.
- CAPITAO_ATLETA_ID e RESERVA_MAGO_ATLETA_ID INT UNSIGNED nullable, FKs FANTASY_CATALOGO_ATLETA.ID, DELETE/UPDATE RESTRICT. Um campo para cada papel garante no máximo uma escolha; CHECK impede o mesmo ID nos dois campos.
- CRIADO_EM e ATUALIZADO_EM DATETIME(3).
- Índices: proprietário/competição/ID, competição, capitão e Reserva do Mago.

`FANTASY_ESCALACAO_ATLETA`:

- ID INT UNSIGNED AUTO_INCREMENT, PK.
- ESCALACAO_ID INT UNSIGNED, FK FANTASY_ESCALACAO.ID, DELETE CASCADE.
- CATALOGO_ATLETA_ID INT UNSIGNED, FK FANTASY_CATALOGO_ATLETA.ID, DELETE RESTRICT.
- PAPEL ENUM(TITULAR, TECNICO, RESERVA).
- UNIQUE(ESCALACAO_ID, CATALOGO_ATLETA_ID), índice CATALOGO_ATLETA_ID.

Nenhum nome, preço, categoria, clube ou posição é copiado do snapshot para as tabelas novas. IDs de atleta nos contratos identificam **FantasyCatalogoAtleta.id**, e não o ID externo do Cartola.

O banco garante FKs, unicidade e quatro CHECKs. Pertencimento do capitão/mago à seleção, composição posicional, categoria e elegibilidade por competição são verificados pelo serviço dentro da transação. Escrita SQL direta fora do serviço não substitui essas validações.

## Formações

| Formação | Goleiro | Laterais | Zagueiros | Meias | Atacantes | Técnico adicional |
|---|---:|---:|---:|---:|---:|---:|
| 4-3-3 | 1 | 2 | 2 | 3 | 3 | 1 |
| 4-4-2 | 1 | 2 | 2 | 4 | 2 | 1 |
| 3-5-2 | 1 | 0 | 3 | 5 | 2 | 1 |
| 3-4-3 | 1 | 0 | 3 | 4 | 3 | 1 |
| 4-5-1 | 1 | 2 | 2 | 5 | 1 | 1 |
| 5-3-2 | 1 | 2 | 3 | 3 | 2 | 1 |
| 5-4-1 | 1 | 2 | 3 | 4 | 1 | 1 |

Total completo: 11 jogadores titulares + um técnico + cinco reservas = 17 atletas distintos.

## Reservas — regra proposta e confirmada pelo usuário

Cinco reservas: um goleiro, um zagueiro, um meia, um atacante e um quinto defensor. O quinto é lateral nas formações com laterais; é segundo zagueiro em 3-5-2 e 3-4-3. Assim não existe reserva de posição ausente dos titulares.

O reserva deve ter categoria congelada menor ou igual à menor categoria de **todos** os titulares selecionados da mesma posição. Bronze=1, Prata=2, Ouro=3. Não há recálculo com preço atual ou consulta ao mercado.

Em rascunho, um reserva pode ser selecionado antes dos titulares da posição. A resposta marca a validação de categoria como pendente; quando houver titulares, a restrição já é exigida. A mudança de formação não remove atletas silenciosamente: seleção incompatível é rejeitada e deve ser enviada corrigida na mesma edição.

O capitão deve estar entre os jogadores titulares. O Reserva do Mago deve ser um dos cinco reservas e pode ser goleiro. Técnico não pode ocupar nenhum desses papéis. Não existe multiplicador de pontos nem substituição automática.

## Rascunhos e validação completa

Todos os registros permanecem em RASCUNHO. A resposta inclui `validacao: { completa: boolean, pendencias: string[] }`, distinguindo explicitamente rascunho incompleto de rascunho cuja seleção está completa.

Validação incremental sempre rejeita duplicação, inelegibilidade, técnico em posição incorreta, excesso por posição, composição inválida de reservas, capitão/mago fora da seleção e categorias superiores. A validação completa adicional exige 11 titulares, técnico, cinco reservas, capitão e Mago.

Não existe confirmação, inscrição, reserva de vaga nem quota de rascunhos baseada no limite de escalações confirmadas. O valor 30 da competição 1 é preservado como configuração. POINTCOINS não têm teto de orçamento.

## Bloqueio centralizado

`assertLineupEditable` é usada em criação, edição, duplicação e exclusão. O relógio é do servidor.

Exige competição PUBLICADA, catálogo CONGELADO correspondente à temporada/rodada, abertura já alcançada e ausência de fechamento definitivo ocorrido. Todas as partidas devem existir, estar AGENDADA, sem INICIO_REAL e com INICIO_PREVISTO futuro. Exatamente no horário previsto da primeira partida, todas as mutações ficam bloqueadas.

Sem fonte confiável de início/atraso, usa-se conservadoramente o horário persistido. Qualquer status diferente de AGENDADA ou INICIO_REAL preenchido bloqueia. Não há reabertura automática, consulta ao relógio do frontend ou alteração dos horários homologados.

FIM_INSCRICAO não é usado como confirmação de escalação: rascunhos não são inscrições, e o regulamento solicitado bloqueia no início da primeira partida (ou antes, por fechamento definitivo). Leitura das próprias escalações continua disponível depois do bloqueio.

A permissão é verificada antes e ao final de cada operação de escrita; ultrapassar o horário durante a transação causa rollback.

## APIs autenticadas

Todas exigem Bearer JWT. IDs de usuário não são aceitos no corpo. Outro proprietário recebe 404, inclusive em duplicação e exclusão.

| Método | Rota | Entrada |
|---|---|---|
| POST | /point-fantasy/competicoes/:id/escalacoes | CreateLineupDto |
| GET | /point-fantasy/competicoes/:id/escalacoes/minhas | page=1, limit=50 (máximo 100) |
| GET | /point-fantasy/escalacoes/:id | — |
| PATCH | /point-fantasy/escalacoes/:id | UpdateLineupDto, versao obrigatória |
| POST | /point-fantasy/escalacoes/:id/duplicar | `{ "versao": 1 }` |
| DELETE | /point-fantasy/escalacoes/:id?versao=1 | versao obrigatória na query |

Criar rascunho vazio:

```json
{ "formacao": "4-3-3" }
```

Campos opcionais de seleção: `titulares: number[]`, `tecnico: number|null`, `reservas: number[]`, `capitaoAtletaId: number|null`, `reservaMagoAtletaId: number|null`.

PATCH: campos omitidos são preservados; arrays enviados substituem a lista correspondente; arrays vazios removem a seleção. `null` limpa técnico/capitão/Mago; arrays e formação não aceitam null. Remover um capitão ou Mago da seleção exige limpar ou escolher novamente esse campo na mesma requisição.

Resposta individual: `{ id, competicaoId, status, versao, criadoEm, atualizadoEm, formacao, titulares, tecnico, reservas, capitaoAtletaId, reservaMagoAtletaId, atletas, validacao }`. `atletas` contém papel, catalogoAtletaId e o snapshot referenciado, sem dados do usuário. Listagem: `{ items, total, page, limit }`.

IDs, categoria e POINTCOINS são números; Decimal do snapshot serializa como string; datas como ISO UTC. POST 201, demais sucessos 200; 400 entrada/seleção inválida, 401 JWT ausente/inválido, 403 usuário inativo/bloqueado, 404 recurso inexistente ou de outro proprietário, 409 bloqueio temporal/estado/versão/concorrência.

PATCH incrementa VERSAO somente após validar. O UPDATE/DELETE condicional por ID, proprietário, status e versão impede perda de edição. Transação Serializable trata disputa/deadlock como 409. Duplicação exige versão da origem, revalida toda a seleção e produz novo ID e versão 1; não há cópia de inscrição/pagamento.

## Migration e ambiente local

Migration nova: `prisma/migrations/0025_point_fantasy_lineups/migration.sql`. Cria somente duas tabelas e adiciona constraints nelas. Os modelos existentes recebem apenas relações inversas no Prisma, sem ALTER nas tabelas antigas.

A migration foi testada em MySQL local isolado antes de aplicar no banco autorizado. O primeiro ensaio detectou incompatibilidade do CHECK com ON UPDATE CASCADE nos campos capitão/Mago; a migration ainda inédita foi corrigida para RESTRICT e validada em outro banco vazio. Nenhuma migration anterior foi modificada. Os bancos de teste foram preservados para inspeção; fixtures do ensaio bem-sucedido são removidas ao final.

Antes da aplicação local: alvo conferido, único pendente 0025, checksums anteriores conferidos, tabelas novas ausentes e backup completo com mysqldump, 35 tabelas, SHA-256 verificado. Backup fora do repositório:

`C:/Users/piter/AppData/Local/Temp/point-ffc-backups/fantasy_point_do_jogador-before-0025-2026-10-15T16-01-43-079Z.sql`

A 0025 foi aplicada somente em `127.0.0.1:3306/fantasy_point_do_jogador`. As duas tabelas estão vazias. Conferidos oito campos PK/FK INT UNSIGNED, seis FKs e quatro CHECKs ativos. Prisma migrate status informa banco atualizado.

Não iniciar a aplicação em NODE_ENV=production para testes: o bootstrap existente roda migrations nesse modo. Nenhuma inicialização de produção ou alteração desse bootstrap foi feita nesta fase.

## Arquivos desta fase

Novos:

- `src/point-fantasy/lineups/lineup.dto.ts`
- `src/point-fantasy/lineups/lineup.rules.ts`
- `src/point-fantasy/lineups/lineup.service.ts`
- `src/point-fantasy/lineups/lineup.controller.ts`
- `src/point-fantasy/lineups/README.md`
- `prisma/migrations/0025_point_fantasy_lineups/migration.sql`
- `test/point-fantasy-lineup.fixture.ts`
- `test/point-fantasy-lineup.{rules,service,controller,integration}.spec.ts`

Modificados nesta fase: `prisma/schema.prisma` e `src/point-fantasy/point-fantasy.module.ts`. Demais alterações no Git já existiam na branch foundation.

## Limitações e Fase 2B

- O bloqueio usa os dados persistidos das partidas; sincronização confiável de início/reagendamento permanece pendente. A política conservadora evita reabertura por atraso presumido.
- Toda gravação de escalação deve passar pelo serviço para manter as regras de pertencimento, posição e categoria.
- Não há limite máximo de rascunhos definido pelo regulamento. Paginação é limitada; quotas operacionais futuras precisam ser definidas separadamente do limite de confirmadas.
- A integração HTTP testa o JwtAuthGuard existente com identidade de teste; não usa tokens reais de usuários.
- Na Fase 2B, conectar a interface aos contratos de seleção, exibir pendências, categorias dos reservas e bloqueio, e tratar 409 recarregando a versão atual. Não assumir que `validacao.completa` equivale a inscrição ou confirmação.

Nenhum frontend, campinho, inscrição, pagamento, PIX, carteira, pontuação, ranking, apuração ou substituição automática foi implementado. Sem commit, push, merge ou deploy.

## Resultados finais da validação

- 73 testes novos de regras, serviço e contrato HTTP aprovados.
- 18 testes novos de integração MySQL aprovados, inclusive as sete formações, permissões, concorrência, rollback, FK e exclusão em cascata.
- Suíte geral: 102 suites / 2.335 testes aprovados; 13 suites / 75 testes skipped por configuração. Os 18 novos testes MySQL foram executados separadamente no banco dedicado.
- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `prisma validate`: aprovado.
- `prisma generate`: aprovado inicialmente no destino padrão e, após o ajuste referencial, aprovado com o schema atual em saída temporária isolada.
- `npx.cmd nest build`: aprovado.
- `npm.cmd run build`: pendência operacional. A etapa padrão de geração retorna EPERM ao substituir query_engine-windows.dll.node, que está carregada por backends locais em execução. Também ocorreu fora do sandbox. Nenhum processo foi interrompido. Após encerrar/reiniciar coordenadamente esses processos, repetir o comando completo; não foi alterado o script para ocultar essa falha.
- `git diff --check`: aprovado.
- Migration 0025 aplicada com sucesso no banco autorizado; status atualizado, tabelas novas vazias, oito índices, oito campos de PK/FK unsigned, seis FKs e quatro CHECKs ativos.
- Nenhuma estrutura das 35 tabelas anteriores foi alterada. Os dados do catálogo 3, atletas, competição 1 e tabelas financeiras mantiveram os checksums.
- Foi observada alteração de dados em RODADA_PROCESSAMENTO durante a execução; registros de rodadas 26/27 tiveram atualizadoEm em 15/10/2026 às 13:04 (São Paulo). Existem backends locais em execução. O módulo novo não lê nem escreve nessa tabela, e os testes de processamento usam mocks. Não foi feito rollback ou interferência nesses processos; a comparação global não deve ser interpretada como ausência de toda atividade concorrente no banco.
- Banco de testes bem-sucedido: `point_fantasy_lineups_2a_test_1792080059149`; fixtures removidas ao final. O primeiro banco de ensaio `point_fantasy_lineups_2a_test_1792079999001` ficou com a tentativa inicial de migration falha, somente para inspeção. Nenhum deles é o banco principal e nenhum foi apagado/recriado.

Reexecutar integração somente em banco dedicado com prefixo `point_fantasy_lineups_2a_test_` e migrations aplicadas, configurando POINT_FANTASY_TEST_DATABASE_URL no processo. Nunca apontar essa variável ao banco principal. Sem a variável, a integração é ignorada.
# Fase 6B — confirmação FREE

`POST /point-fantasy/competicoes/:id/inscricoes` exige JWT de usuário ativo.
Corpo: `{ "escalacaoIds": [1, 2], "chaveIdempotencia": "confirm-001" }`.
Aceita de 1 a 100 IDs únicos de rascunhos existentes do próprio usuário na
competição. A chave é obrigatória, com 1–100 caracteres alfanuméricos ASCII,
`_` ou `-`. Não envia seleção, valor ou identidade nesse endpoint.

Resposta: `{ competicao: { id, nome, tipoAcesso }, escalacoes: [{ id,
nomePublico, status: "INSCRITA", confirmadaEm }], quantidadeConfirmada,
valorTotal: "0.00", estado: "CONFIRMADA" }`. Datas são ISO UTC; nome público
continua nulo para legados sem identidade. A operação não cria times nem identidade.

O lote é atômico e exige PUBLICADA/FREE, valor zero, catálogo congelado,
seleções completas e elegíveis, limite por usuário e janela
`inicioInscricao <= agora < fimInscricao`, antes do fechamento definitivo e
de qualquer partida iniciada, prevista ou fora de AGENDADA. Rascunhos não
consomem o limite. Não há efeitos financeiros.

Repetir a mesma chave e o mesmo conjunto de IDs (a ordem não importa) retorna
o resultado persistido, inclusive após encerrar o período. Outro conjunto com
a mesma chave retorna 409. Uma escalação já inscrita com outra chave retorna
409; o lote inteiro é rejeitado. Após conflito concorrente 409, repetir a mesma
requisição e chave. A idempotência é restrita ao usuário e à competição.

`GET /point-fantasy/competicoes/:id/escalacoes/minhas` e
`GET /point-fantasy/escalacoes/:id` preservam seus campos e acrescentam
`confirmadaEm` (null para rascunho). Escalações INSCRITA ficam bloqueadas para
DELETE e duplicação, mantendo leitura privada. O PATCH de inscritos FREE segue
as regras da Fase 2C abaixo.
A janela de edição dos rascunhos existentes permanece a mesma; confirmação
tem a verificação adicional obrigatória de fimInscricao.

A migration aditiva `0027_point_fantasy_free_registration` cria o registro de
operação e adiciona data e vínculo à escalação. Preserva dados legados e amplia
o CHECK de status para RASCUNHO/INSCRITA com consistência dos campos novos.
FK composta vincula a operação ao mesmo proprietário e competição. Aplicar
pelo processo habitual antes de disponibilizar o código; não há migração de
rascunhos para inscritos nem inscrição retroativa.

Testes: `npx jest --runInBand --testPathPattern=point-fantasy`.
Integração opt-in usa a infraestrutura e a validação de URL local já existentes
em `test/point-fantasy-lineup.integration.spec.ts`; requer banco dedicado com
a migration 0027 aplicada. Sem `POINT_FANTASY_TEST_DATABASE_URL`, integrações
são ignoradas. Testes unitários com fake não comprovam locks e rollback MySQL.

## Fase 2C — edição de inscritos FREE

O PATCH existente aceita inscritos somente em competição FREE com valor zero,
por usuário ativo e proprietário, com a versão atual e elenco resultante completo
e válido. Campos omitidos são preservados conforme o contrato existente.
Somente seleção e versão são atualizadas; ID, status, confirmação, operação de
inscrição, identidade, nome e código públicos permanecem intactos.

A janela termina no primeiro entre fimInscricao, fechamento definitivo e início
previsto ou real de qualquer partida. O instante exato já é bloqueado. Continuam
valendo os bloqueios de status, catálogo, elegibilidade e partidas existentes.
Rascunhos mantêm suas regras anteriores, inclusive quanto a fimInscricao.

A edição usa transação Serializable, bloqueia a competição como na confirmação,
e verifica novamente estado e prazo ao final. Leituras de catálogo e partidas
nessa transação protegem contra escritas administrativas concorrentes. Conflitos
de versão ou serialização retornam 409; falhas revertem também todos os atletas.
Exclusão, duplicação e reinscrição permanecem proibidas para inscritos. Nenhum
endpoint de inscrição, migration ou operação financeira foi alterado.
