# Fase 3G — persistência e ranking homologados no MySQL local

## Resultado

Execução em 23/10/2026 exclusivamente em `127.0.0.1:3306/fantasy_point_do_jogador`.
Branch `feat/point-fantasy-scoring-observation-3b2`; alterações locais anteriores
preservadas. Nenhum código de domínio ou migration foi alterado nesta fase.

- Migrations **0031_point_fantasy_lineup_results** e
  **0032_point_fantasy_closure_audit** aplicadas pelo `prisma migrate deploy`.
- Tabelas FANTASY_ESCALACAO_RESULTADO e FANTASY_FECHAMENTO_AUDITORIA criadas.
- Colunas, precisão DECIMAL(40,18), índices únicos, índice de ranking e as três
  FKs foram conferidos em information_schema, incluindo referências compostas
  e ações RESTRICT.
- Fechamento definitivo da competição 1 realizado em
  **23/10/2026 às 14:21:53,704 (America/Sao_Paulo)**;
  valor persistido UTC: `2026-10-23T17:21:53.704Z`.
- **3 resultados persistidos**, somente escalações **5, 6 e 7**, sem duplicidade.
- Ranking consultado pelo `PointFantasyService.ranking` duas vezes, com respostas
  idênticas, ordenação e precisão decimal conferidas.

| Posição real | Escalação | Pontuação persistida |
|---|---|---|
| 1 | 7 — chute de ouro 03 | 85,51 |
| 2 | 5 — chute de ouro 01 | 34,41 |
| 3 | 6 — chute de ouro 02 | 30,31 |

Os valores foram recalculados pelo motor. As referências esperadas foram usadas
exclusivamente em assertions de conferência, nunca para montar INSERT/UPDATE.

## Substituições efetivamente persistidas

| Escalações | Saiu | Entrou | Regra | Pontuação oficial | Contribuição |
|---|---|---|---|---|---|
| 5 e 6 | Esquivel (494) | Gilberto (172) | COMUM | −0,2 | 0 |
| 5 e 6 | Bernard (246) | Medina (704) | COMUM | 3,2 | 3,2 |
| 5 e 6 | Arthur Cabral (147) | Leozinho (502) | COMUM | 2,6 | 2,6 |
| 7 | Bernard (246) | Medina (704) | COMUM | 3,2 | 3,2 |
| 7 | Vitor Roque (656) | Breno Lopes (617) | COMUM | 1,3 | 1,3 |

IDs nesta tabela são do catálogo congelado. Nenhum reserva foi utilizado duas
vezes. Leozinho/Breno Lopes são marcados como Mago, mas entram pela regra comum;
nenhuma substituição adicional MAGO foi acionada indevidamente.

| Escalação | Capitão | Multiplicador e contribuição persistidos |
|---|---|---|
| 5 | Esquivel, substituído por Gilberto | Gilberto herda 2x; piso zero da reserva comum → 0 |
| 6 | Cuello | 0,5 × 2 = 1 |
| 7 | Luiz Gustavo | 2,5 × 2 = 5 |

Cada resultado contém auditoria JSON com 12 contribuições finais (11 titulares
efetivos e técnico), substituições, multiplicadores, origem da participação,
versão da escalação e evidências. As somas foram conferidas antes do commit
e a auditoria persistida foi comparada integralmente ao resultado do motor.

## Revisão, hash e evidências

- Competição **1**, temporada **2026**, rodada **31**.
- Revisão autorizada/usada: **2**; **306 registros oficiais**, sem modificação.
- Hash associado aos três resultados:
  `125a24de4479be5b5f37013a1370e2630465f40186d89686dab708b36bbef435`.
- Pontos provenientes da coleta corrente **8**; versão do motor **3F-1**.
- Participação inferida com coleta histórica **3**, snapshot **1**, confrontos
  **346526, 346530 e 346532**, conforme adaptador Cartola já homologado.
- Hash do payload histórico:
  `351d4cabdac15af4b02436da44ff2b01800fbed56e5249837826d81ec9be6687`.
- Hash das partidas preservadas:
  `976f3db71fd3d6cb8bc3b5dcf3ab437563a7a5faca7988979973ab67d3f3f633`.

## Execução controlada

O preflight confirmou identidade local/servidor, três escalações confirmadas e
elegíveis (versões 3/4/2), revisão/hash autorizados, prévia completa, migrations
aditivas e somente 0031/0032 pendentes. Todos os arquivos de migration foram
comparados ao histórico; as exceções históricas 0024/0025 já documentadas
coincidiram com os pares conhecidos, sem reparo de histórico.

A comparação somente de leitura do schema também apontou três diferenças de
**nomes** de FKs da migração 0030. As relações, colunas e ações são equivalentes
às definidas no arquivo histórico. Nenhuma dessas FKs foi renomeada ou alterada;
o diff não foi executado como SQL.

DDL foi executado uma única vez pelo mecanismo Prisma existente. Depois do
sucesso das migrations, houve um erro no relatório local: JSON não serializava
um BigInt dos metadados de índices. Corrigida somente a serialização do executor,
as migrations concluídas foram reconferidas em leitura e o estado local foi
reconstituído, **sem repetir DDL ou modificar metadados no banco**.

Fechamento e persistência foram executados em uma única transação externa
Serializable, compartilhada pelos serviços existentes. O administrador ativo foi
verificado no banco pelo `PointFantasyService.closeCompetition`, sem fabricar
JWT ou contornar validações. A chamada local utilizou a autorização expressa
do usuário. Revisão/hash, escopo, prévia e ausência de resultados anteriores
foram reconferidos com os locks adquiridos, antes das escritas dos serviços.

O fechamento foi realizado pelo serviço administrativo; os resultados, pelo
`LineupScoringService.persist`. Não houve UPDATE SQL manual para fechamento
nem gravação manual de pontuações. Falha nas conferências internas teria revertido
o lote de fechamento e resultados. Os serviços de domínio não foram modificados.

## Verificações de preservação

Comparação por quantidade e SHA-256 canônico dos registros em **46 tabelas
protegidas** antes/depois, abrangendo pontuações oficiais, coleta/snapshots,
rodada 32, escalações, inscrições, carteiras, PIX, competições e resultados
tradicionais. Em FANTASY_COMPETICAO, todas as outras competições e todos os campos
da competição 1 foram comparados, exceto os dois campos autorizados de fechamento
e atualização. Todos permaneceram iguais.

Cada linha original de `_prisma_migrations` foi comparada por hash: inalteradas.
Apenas as duas migrations autorizadas foram acrescentadas ao histórico.
Há exatamente três resultados e uma auditoria de fechamento nas novas tabelas.

Testes desta execução: **12 suítes, 241 testes aprovados**, exclusivamente
memória/mocks. Não foram criados bancos/schemas temporários. Também foram
verificados sintaxe do executor, prévia integrada, somas, schema/FKs/índices,
auditoria, precisão, ausência de duplicidade, duas leituras do ranking e
`git diff --check`.

## Estado final e evidências

Homologação local concluída; nenhuma pendência de persistência/ranking.
O serviço retorna `estadoPontuacao=PARCIAL`, conforme contrato existente: o
fechamento definitivo da competição não altera o estado oficial da apuração
nem declara validação global da rodada ou premiação. A competição permanece
publicada para disponibilizar seu ranking, com fechamento definitivo registrado.

Nenhuma coleta Cartola, operação financeira, acesso a produção/Render,
alteração de frontend, commit, push, merge ou deploy foi realizado.

Artefatos:

- `docs/point-fantasy-3g-results.json`: fechamento, resultados persistidos,
  contribuições, substituições, evidências e ranking real.
- `docs/point-fantasy-3g-state.json`: preflight, fingerprints e metadados verificados.
- `docs/point-fantasy-3g-migrations.log`: saída do Prisma, sem credenciais.
- `scripts/point-fantasy-3g-local.cjs`: executor controlado. Estado final VERIFIED;
  não repetir seus estágios de escrita.
