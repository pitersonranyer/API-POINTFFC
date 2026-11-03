# Fase 3F — prévia integrada Cartola/Fantasy

## Resultado

As três escalações foram calculadas pelo método público
`LineupScoringService.preview(1)`, usando o adaptador integrado e o motor Fantasy
existente. Nenhuma pendência de atleta permaneceu. As somas das 12 contribuições
de cada escalação foram conferidas com precisão decimal.

| Posição na prévia | Escalação | Pontuação | Soma conferida |
|---|---|---|---|
| 1 | 7 — chute de ouro 03 | 85,51 | 85,51 |
| 2 | 5 — chute de ouro 01 | 34,41 | 34,41 |
| 3 | 6 — chute de ouro 02 | 30,31 | 30,31 |

Não houve divergência em relação às referências da auditoria. Não houve empate
nestes três resultados; a classificação com empates continua coberta por testes.
Esta classificação é uma prévia, não o ranking já persistido no MySQL.

## Substituições e capitães

| Escalações | Saiu | Entrou | Regra | Pontos oficiais do reserva | Contribuição |
|---|---|---|---|---|---|
| 5 e 6 | Esquivel | Gilberto | Comum | −0,2 | 0 |
| 5 e 6 | Bernard | Medina | Comum | 3,2 | 3,2 |
| 5 e 6 | Arthur Cabral | Leozinho | Comum | 2,6 | 2,6 |
| 7 | Bernard | Medina | Comum | 3,2 | 3,2 |
| 7 | Vitor Roque | Breno Lopes | Comum | 1,3 | 1,3 |

No time 5, Gilberto herda o capitão 2x; a contribuição continua zero por causa
do piso da reserva comum. No time 6, Cuello contribui 0,5 × 2 = 1. No time 7,
Luiz Gustavo contribui 2,5 × 2 = 5. O técnico Eduardo Domínguez contribui 9,01
em cada time. Leozinho e Breno Lopes são os reservas marcados como Mago, mas
a solução ótima utiliza cada um pela regra comum; não há segunda utilização.
Léo permanece com zero inferido nos times 5/6, pois Lyanco também não participou.
Pontuações negativas dos titulares que jogaram foram preservadas.

## Implementação e reaproveitamento

Novo adaptador `src/point-fantasy/scoring/cartola-evidence.ts` consulta somente
as coletas/snapshots existentes no banco. Reutiliza diretamente, sem modificar
`round-processing/round-calculator.ts`:

- `scoreMap`: valida o envelope preservado, rodada e valores.
- `matchesByClub`: associa os clubes aos confrontos e rejeita ambiguidades.
- `matchEnded`: exige partida válida com período F ou POS_JOGO.
- `athleteParticipation`: infere ausência somente com envelope estruturalmente
  íntegro, partida encerrada e atletas pontuados do mesmo clube.
- `matchStart`: confere horário e ano dos confrontos selecionados.

Valida sucesso HTTP, vínculo entre coleta/snapshot/apuração, igualdade e hash do
payload, temporada antes/depois da resposta, rodada do envelope e identidade
exata dos confrontos selecionados. Candidatos são processados por ID decrescente;
sem evidência válida, a participação permanece desconhecida.

Somente a participação é derivada da evidência histórica. Pontos, inclusive
negativos e decimais, continuam vindo de `FANTASY_PONTUACAO_ATLETA` da revisão
corrente. Um registro atual com informação insuficiente ou identidade divergente
não ganha pontuação histórica. Não há INSERT/UPDATE de zero oficial fabricado.

`source-completeness.ts` conserva a verificação da revisão/hash e integridade do
conjunto atual. Remove a exigência global de `encerramentoRodada`, certificado
completo e término de partidas fora da competição. `resolveScoringSource` usa
o resultado da função Cartola e registra `NAO_PARTICIPACAO_INFERIDA_CARTOLA`.

`LineupScoringService` e `PointFantasyService.closeCompetition` compartilham esse
adaptador. O motor `scoring-engine.ts` não foi modificado: continuam 11 titulares,
técnico, capitão 2x, piso zero do reserva comum, Mago, otimização determinística
e empates preservados. A versão do processamento passou a `3F-1` para impedir
uso silencioso de resultados de regras anteriores.

A extensão `roundCompletion` adicionada na Fase 3E foi removida do contrato e
da serialização da coleta. As políticas anteriores de coleta atual, de ordenação,
de revisão e de admissão de escrita foram preservadas. Não há nova coleta nem
modificação do motor Cartola.

## Evidência usada na prévia real

- MySQL exclusivamente local, `fantasy_point_do_jogador`, versão 8.0.25.
- Competição 1, temporada 2026, rodada 31, escalações 5/6/7 confirmadas,
  versões 3/4/2.
- Apuração 1, revisão corrente **2**, **306 registros**, última coleta aplicada 8.
- Hash corrente:
  `125a24de4479be5b5f37013a1370e2630465f40186d89686dab708b36bbef435`.
- Participação: coleta histórica **3**, snapshot **1**, 275 atletas com
  `total_atletas=275`, temporada 2026 e rodada 31 conferidas.
- Hash do payload histórico:
  `351d4cabdac15af4b02436da44ff2b01800fbed56e5249837826d81ec9be6687`.
- Hash do retorno preservado das partidas:
  `976f3db71fd3d6cb8bc3b5dcf3ab437563a7a5faca7988979973ab67d3f3f633`.
- Confrontos 346526, 346530 e 346532 em POS_JOGO, válidos e compatíveis.
- A partida de fora da competição ainda não encerrada no snapshot não impede
  o cálculo. Não se declarou encerramento global da rodada.

Auditoria registra, separadamente, revisão/hash atuais e coleta/snapshot/hashes
da participação. Reprocessamento compara essa evidência de modo canônico, além
das versões/hash/revisão, preservando idempotência e atualização quando a prova muda.

## Fechamento e migrations

O endpoint administrativo existente foi adaptado, sem criação de outro endpoint.
Exige administrador ativo, competição publicada, inscrições encerradas, catálogo
congelado, identidade, revisão/hash e evidência dos confrontos selecionados.
Mantém transação Serializable, locks, auditoria e replay idempotente.

As condições de leitura passaram na homologação: há administrador ativo,
janela de inscrição encerrada e evidências válidas para os três confrontos.
`fechamentoDefinitivoEm` continua null. Não foi chamado o método de fechamento
contra o banco real. Sua transação foi validada com mocks.

As migrations existentes permaneceram inalteradas e **não foram aplicadas**:

| Migration | Operação |
|---|---|
| 0031_point_fantasy_lineup_results | Índice composto em FANTASY_ESCALACAO e criação de FANTASY_ESCALACAO_RESULTADO |
| 0032_point_fantasy_closure_audit | Criação de FANTASY_FECHAMENTO_AUDITORIA |

Ambas são aditivas, sem operações destrutivas. IDs/FKs são compatíveis com os
`int unsigned` locais. As duas novas tabelas ainda não existem. São as únicas
migrations pendentes; registros antigos de rollback 0007/0023 já estão resolvidos
e não foram alterados. Nenhum script antigo de preparação foi executado.
Validação efetiva do DDL/FKs no banco ficará para a aplicação autorizada.

## Arquivos desta fase

- `src/point-fantasy/scoring/cartola-evidence.ts`: adaptador novo.
- `src/point-fantasy/scoring/source-completeness.ts`: integridade atual e origem
  da participação, sem certificado global.
- `src/point-fantasy/scoring/lineup-scoring.service.ts`: prévia/persistência
  integradas e versão 3F-1.
- `src/point-fantasy/point-fantasy.service.ts`: fechamento com o mesmo adaptador.
- `src/point-fantasy/observation/current-scoring-policy.ts` e
  `current-scoring.service.ts`: retirada da extensão redundante da Fase 3E.
- Testes/fixtures de fonte, fechamento, persistência, ranking e coleta ajustados.
- `scripts/point-fantasy-3f-preview.cjs`: prévia oficial, conferência das somas
  e preflight somente de leitura.
- `docs/point-fantasy-3f-preview.json`: saída auditável com contribuições,
  substituições, classificações e evidências.

## Validação e próximo passo

**12 suítes, 241 testes aprovados**, exclusivamente mocks/memória. Typecheck,
build e `git diff --check` aprovados. Cobertura inclui ausência válida/inválida,
partida externa pendente, fonte truncada, hash/identidade divergentes, prioridade
dos pontos atuais, capitães, reservas negativos, conflitos, empates, idempotência,
autorização administrativa e rollback.

Depois dos testes e build, foi executado:

```powershell
node scripts/point-fantasy-3f-preview.cjs
```

Nenhuma escrita no MySQL, nova tabela/certificado/migration de código nesta fase,
coleta, operação financeira, modificação de inscrições/escalações, rodada 32,
produção, frontend, commit, push, merge ou deploy. Alterações locais preservadas.

Falta exclusivamente autorização para aplicar 0031/0032, fechar a competição 1,
persistir os três resultados da revisão/hash acima e consultar o ranking real.
Antes da escrita, devem ser reconferidas as identidades, versões, revisão e hash;
qualquer divergência exige interromper a operação. Não há pendência funcional
identificada na prévia integrada.
