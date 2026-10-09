# Reprocessamento administrativo de rodadas

`POST /admin/rodadas/:rodada/reprocessar-parciais?temporada=2026`

Sem body. Parâmetros obrigatórios: `rodada` inteiro de 1 a 38 no path e
`temporada` inteiro de 1 a 65535 na query. Autenticação: `Authorization: Bearer <JWT>`
de usuário `PLATFORM_ADMIN` (ADMIN no produto).

Sucesso HTTP 200, objeto direto no padrão dos controllers do projeto:

```json
{
  "temporada": 2026,
  "rodada": 26,
  "status": "PARCIAL",
  "timesProcessados": 4832,
  "timesComErro": 0,
  "substituicoesAlteradas": 37,
  "duracaoMs": 1843,
  "processadoEm": "2026-09-07T15:00:00.000Z"
}
```

`timesProcessados` conta times recalculados e persistidos com sucesso.
`timesComErro` conta falhas individuais de cálculo, registradas no log do backend;
esses times mantêm os resultados anteriores. Na parcial, pendências também são
contabilizadas e registradas no log; uma posição elegível pode ser calculada enquanto
outras permanecem pendentes. Falha de persistência reverte a transação dos resultados.
Na avaliação histórica administrativa, pendências individuais não bloqueiam os
times comprovados. A consolidação automática mantém seu comportamento anterior.
O campo `status` retorna `FINAL` somente quando esta execução comprova a consolidação
global; caso contrário, retorna `PARCIAL`, mesmo se o banco já tinha uma marca antiga
de `CONSOLIDADA` que não pode ser confirmada pelas evidências atuais.
`substituicoesAlteradas` conta relações ativadas/desativadas ou com posição corrigida
(trocar uma relação por outra conta duas alterações). Uma repetição com os mesmos
dados mantém pontuações e relações, retornando zero alterações de substituição.
Duração e horário variam a cada chamada.

Na avaliação individual histórica, a resposta acrescenta:

| Campo | Significado |
| --- | --- |
| `totalTimes` | União dos snapshots existentes e times previstos sem snapshot |
| `atualizados` | Resultados seguros efetivamente gravados, incluindo promoção de PARCIAL para FINAL |
| `inalterados` | Resultados comprovados já FINAL com mesma pontuação e substituições; não regravados |
| `pendentes` | Times com dependências oficiais ainda indeterminadas; resultados preservados |
| `naoVerificaveis` | Snapshots ausentes ou inválidos; resultados preservados |
| `rodadaConsolidada` | Consolidação global comprovada nesta execução |
| `statusRodada` | Estado persistido, que pode continuar CONSOLIDADA sem confirmação atual |
| `resultado` | ATUALIZADO, SEM_ALTERACOES ou COM_PENDENCIAS |
| `motivosPendencia` | Objetos com timeId, tipo e motivo; timeId nulo identifica pendência global |

Um time não é comprovado pela coincidência da pontuação. A validação exige envelope
completo, snapshot válido, término confirmado e horário válido de todas as partidas
dos clubes do snapshot, participação suficiente e nenhuma substituição indeterminada.
Reutiliza as validações e cálculo existentes. Partidas irrelevantes não bloqueiam o
time; continuam impedindo a consolidação global quando não têm término comprovado.
Resultados individuais comprovados são FINAL, com consolidadoEm, mesmo que a rodada
continue pendente. As regras de inferência de ausência de atletas omitidos permanecem iguais.

Erros no formato padrão Nest (`statusCode`, `message`, `error`):

| HTTP | Motivo |
| --- | --- |
| 400 | Temporada/rodada inválida, temporada diferente da oficial atual ou rodada futura |
| 401 | JWT ausente, inválido ou expirado |
| 403 | Usuário sem perfil ADMIN ou bloqueado |
| 404 | Rodada não encontrada em RodadaProcessamento |
| 409 | Lock ocupado/perdido, mudança de contexto, conflito de identidade/validade da fonte; na parcial atual, snapshot incompleto |
| 502 | Resposta oficial malformada ou falha na API oficial |
| 500 | Falha inesperada de persistência/infraestrutura |

O backend consulta `/mercado/status`, `/atletas/pontuados/:rodada` e
`/partidas/:rodada` sem reutilizar o cache de pontuações. Aceita rodadas anteriores
da temporada oficial atual, inclusive consolidadas, e usa os snapshots existentes,
o mesmo motor e a persistência transacional existente. Não recaptura escalações.

A temporada declarada na fonte, quando presente, deve coincidir; os horários das
partidas devem identificar o ano solicitado. Isso valida a origem, não o término.
Consolidação exige partidas válidas com `F`/`POS_JOGO`, envelope completo,
cobertura de partidas dos clubes do snapshot e participação suficiente segundo o
motor existente. Período vazio ou não terminal conserva uma confirmação final já
persistida da mesma partida, clubes, rodada, temporada e horário, com aviso no log.
Mudança de identidade/validade ou resposta incompleta bloqueia a operação e conserva
as evidências anteriores; uma correção conflitante exige análise, não é aceita silenciosamente.
Data, placar, mercado aberto ou contagem de atletas não comprovam término.

Partidas validadas e envelopes completos são preservados antes do cálculo, em
transações próprias com verificação do mesmo lock. Uma falha posterior mantém essas
evidências e os resultados anteriores; a rodada registra cálculo pendente para que a
próxima tentativa recalcule mesmo sem diferença no feed. Dados completos não são
substituídos por envelopes incompletos. Evidência salva não significa resultado consolidado.

Sem confirmação suficiente, uma rodada histórica responde 200 com COM_PENDENCIAS,
preservando os resultados dos times não comprovados. Envelopes incompletos identificados
também produzem pendências; não substituem evidências completas anteriores. Evidências
novas válidas podem ter sido salvas. A marca antiga de CONSOLIDADA e sua data não são
apagadas quando a comprovação global falha. Na rodada atual com mercado fechado e
partidas em andamento, o fluxo parcial anterior é mantido. Posições comprovadas podem ter
trocas progressivas; uma substituição anterior indeterminada ou pontuação `FINAL`
é preservada. Locks são adquiridos e liberados mesmo quando há pendência.
Automático e administrativo usam a mesma preservação e cálculo com término confirmado,
sem o atalho de reabertura baseado apenas em horário passado. Agendamento e janela
automática permanecem iguais; não foi criado retry automático de rodadas históricas.

Após o commit, chama a sincronização existente somente quando resultados seguros
foram efetivamente gravados. Pendentes conservam a pontuação anterior no banco e no
ranking; não há apuração definitiva, mudança do status das competições nem pagamento.
Uma repetição histórica inalterada não regrava resultados nem sincroniza rankings. Ela atende
competições elegíveis de rodada única e inscrições `ATIVA`; não cobre inscrições
`FINALIZADA` nem todas as modalidades de competição. Falhas são registradas em log
e não desfazem a pontuação já gravada. Não altera pagamentos, carteiras ou premiações.

## Próxima tarefa do frontend

Exibir **Reprocessar parciais** somente para ADMIN na área administrativa.
Habilitar com temporada/rodada válidas da temporada atual e rodada existente,
inclusive consolidada, se a interface permitir essa seleção.
Desabilitar se houver processamento em andamento ou indisponibilidade conhecida de
snapshots. Se essas informações não estiverem disponíveis na tela, tratar
o 409 do backend como autoridade; não presumir disponibilidade.

Antes da chamada, confirmar com o texto:

> Os times serão recalculados com as escalações congeladas e dados oficiais atualizados. A rodada poderá ser consolidada se houver confirmação suficiente.

Durante a chamada, desabilitar o botão, mostrar loading e bloquear clique duplicado.
Após sucesso, mostrar times processados, substituições alteradas, erros e duração;
atualizar as parciais exibidas. Se houver erros individuais, indicar conclusão com
falhas. Restaurar o botão conforme o estado atual ao concluir ou receber erro.
O lock no servidor continua sendo a proteção contra concorrência entre usuários.

Nenhuma implementação de frontend faz parte desta alteração.
O botão existente continua chamando a mesma rota; telas que bloqueiam rodadas
consolidadas ou presumem sempre `PARCIAL` precisam de adaptação em tarefa separada.
