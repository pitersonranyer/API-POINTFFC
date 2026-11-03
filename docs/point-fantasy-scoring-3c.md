# Fase 3C — resultados das escalações POINT FFC

## Auditoria e reaproveitamento

Branch local: `feat/point-fantasy-scoring-observation-3b2`. Já havia alterações
não commitadas em `package.json`, `prisma/schema.prisma`, coleta, revisão,
scripts e testes das fases anteriores. Foram preservadas.

Reutilizados:

- `FANTASY_APURACAO_RODADA`: temporada, rodada, revisão atual e hash da fonte.
- `FANTASY_PONTUACAO_ATLETA`: pontuação decimal oficial corrente e evidência de
  participação. `FANTASY_PONTUACAO_COLETA` mantém a origem e alterações por
  revisão. Os snapshots legados permanecem intactos.
- `FANTASY_CATALOGO` e `FANTASY_CATALOGO_ATLETA`: identidade congelada, posição,
  clube e categoria; `validateSelection` valida formação, reservas e categorias.
- `FANTASY_COMPETICAO` e `FANTASY_COMPETICAO_PARTIDA`: escopo dos clubes e jogos.
- `FANTASY_ESCALACAO` e `FANTASY_ESCALACAO_ATLETA`: inscrição, confirmação,
  versão, titulares, técnico, reservas, capitão e Mago.
- Endpoint público de ranking existente, com autenticação opcional e respostas
  sem cache. Não retorna atletas, capitão, Mago ou auditoria.

`PONTUACAO_TIME_RODADA` e `SUBSTITUICAO_TIME_RODADA` pertencem a
`TIME_RODADA`/`TIME_CARTOLA`, não às escalações independentes POINT FFC.
Não foram reutilizadas para evitar misturar domínios e perder precisão decimal.

## Implementação

`src/point-fantasy/scoring/scoring-engine.ts` calcula 11 titulares e um técnico.
Usa os pontos oficiais já persistidos, sem recalcular scouts. Capitão recebe 2x,
inclusive quando negativo. A pontuação do técnico é a do atleta oficial de
posição 6, com identidade e clube conferidos. Aritmética decimal tem precisão
80; o resultado é serializado como string para evitar perda em JSON/JavaScript.

Não participação explicitamente informada vale zero. Ausência de registro ou
pontuação sem evidência de não participação gera total `null` e lista `missing`.
Reserva sem informação também deixa o resultado pendente: não é possível
afirmar qual seria a melhor substituição. Pontuação conhecida com participação
não informada pode pontuar, mas não autoriza tratar o titular como ausente.

As posições são processadas de 1 a 5, e atletas por ID do catálogo crescente.
O motor enumera combinações válidas por posição, comparando o total completo
com o multiplicador do capitão. Cada reserva entra no máximo uma vez:

- Comum: somente por titular explicitamente ausente; contribuição mínima zero.
- Mago: somente por titular original de menor pontuação na posição, entre os
  ainda disponíveis depois das substituições comuns, e quando
  melhora o total; pode contribuir negativamente se superar o titular.
- O Mago também pode cumprir a substituição comum, sem uso duplo. O motor
  compara as alternativas conflitantes, incluindo capitães empatados.
- Empates entre soluções usam ordem de IDs; prefere-se registrar a substituição
  comum quando sua contribuição zero empata com deixar o ausente em campo.

Auditoria registra titular substituído, reserva, regra, pontos oficiais,
contribuição, multiplicador e todas as contribuições finais.

`LineupScoringService` permite preview somente de leitura e persistência
explicitamente invocada. Exige competição publicada, catálogo congelado,
temporada/rodada coerentes e fechamento definitivo efetivado. Só considera
inscrições confirmadas até o fechamento. Inscrição confirmada com seleção
inválida bloqueia o lote, para não produzir ranking silenciosamente incompleto.

As consultas limitam atletas à apuração, temporada, rodada e clubes da
competição. A identidade oficial precisa concordar com o catálogo congelado.

## Persistência e ranking

Migração aditiva `0031_point_fantasy_lineup_results`, preparada e **não aplicada**.
Uma única tabela nova, `FANTASY_ESCALACAO_RESULTADO`, guarda resultado corrente,
revisão, hash, versão da escalação, versão do motor e auditoria JSON.
Chave primária por escalação e FK composta impedem associação com outra
competição. `TOTAL` usa `DECIMAL(40,18)`.

Persistência exige autorização com competição, temporada, rodada e revisão
exatas. Todo o lote roda em transação Serializable, com locks da competição
(mesmo recurso das confirmações) e da apuração (mesmo recurso da coleta).
Conflito/falha aborta o lote. Mesma revisão/hash/versões não faz novos upserts;
nova revisão substitui os resultados correntes, mantendo a auditoria da fonte
nas coletas já existentes. Não há escrita em inscrições nem tabelas financeiras.

Ranking é derivado dos resultados, sem tabela redundante. Ordenação decimal
decrescente, posições `1,1,3` em empate e ID crescente apenas para apresentação.
Paginação ocorre depois da classificação global. Resultados só são consultados
após fechamento definitivo. Só se publicam pontos/posições quando todas as
inscrições têm resultado completo da revisão/hash/versões atuais. Novas revisões
ocultam resultados antigos até reprocessamento. O estado continua `PARCIAL`:
o motor não declara validação definitiva nem executa premiação.

## Validação e consulta local

Em 23/10/2026: 6 suítes, **122 testes aprovados**, exclusivamente memória/mocks:

```powershell
npm.cmd test -- --runInBand --runTestsByPath test/point-fantasy-scoring-engine.spec.ts test/point-fantasy-lineup-scoring.spec.ts test/point-fantasy-result-ranking.spec.ts test/point-fantasy-ranking.spec.ts test/point-fantasy-lineup.rules.spec.ts test/point-fantasy-lineup.service.spec.ts
npm.cmd run typecheck
npm.cmd run build
```

Typecheck e build aprovados. O rollback foi validado com mock transacional;
DDL, FKs e concorrência real ainda precisam de homologação no MySQL autorizado.
Não se criaram schemas/bancos de teste, nem se executaram testes de integração
que criam bancos. Nenhuma coleta ou operação financeira foi executada.

Após a validação, consulta local somente de leitura:

```powershell
node scripts/point-fantasy-lineup-scoring-audit.cjs
```

Destino verificado: MySQL local, banco `fantasy_point_do_jogador`.
Competição **1 — POINT FFC Fantasy — Homologação R31**, temporada 2026,
3 partidas, **3 inscritas, 3 confirmadas e 3 estruturalmente elegíveis**.
Apuração 1: revisão atual **2**, estado `OBSERVANDO`, 306 registros de atletas,
sem revisão validada. `fechamentoDefinitivoEm` está **null**, portanto **0 prontas
para processamento** neste momento. A tabela de resultados ainda não existe no
banco real. Não foram gravados resultados nem alterados dados da rodada 32.

## Pendências para homologação e automação

1. Efetivar o fechamento definitivo pelo fluxo administrativo autorizado.
2. Aplicar a migração 0031 em janela local autorizada, sem executar os scripts
   antigos de preparação que criam bancos temporários.
3. Reexecutar a auditoria/preview e revisar pendências de pontuação oficial.
4. Obter autorização explícita antes de `persist(1, { competicaoId: 1,
   temporada: 2026, rodada: 31, revisao: '2' })`; se a fonte mudar, revisar a
   nova revisão e sua autorização. O método recebe autorização de um chamador
   confiável; não é um endpoint público nem substitui controle de acesso.
5. Homologar resultados reais, FKs e concorrência. Depois conectar um chamador
   autenticado às revisões aceitas, com política de retry/observabilidade.
   O serviço não foi registrado no agendador, bootstrap ou módulo de coleta.

Nenhum commit, push, merge, deploy ou alteração de frontend foi realizado.
