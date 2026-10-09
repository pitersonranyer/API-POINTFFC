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
| `inalterados` | Resultados já FINAL iguais, ou PARCIAL iguais sob presunção histórica; não regravados. Não comprova término oficial |
| `pendentes` | Times com dependências oficiais ainda indeterminadas; resultados preservados |
| `naoVerificaveis` | Snapshots ausentes ou inválidos; resultados preservados |
| `rodadaConsolidada` | Consolidação global comprovada nesta execução |
| `statusRodada` | Estado persistido, que pode continuar CONSOLIDADA sem confirmação atual |
| `resultado` | ATUALIZADO, SEM_ALTERACOES ou COM_PENDENCIAS |
| `motivosPendencia` | Objetos com timeId, tipo e motivo; timeId nulo identifica pendência global |
| `estadosPartidas` | Somente histórico: objetos com partidaId e estado FINAL_CONFIRMADO, FINAL_PRESUMIDO ou PENDENTE |

Um time não é comprovado pela coincidência da pontuação. A validação exige envelope
completo, snapshot válido, término confirmado e horário válido de todas as partidas
dos clubes do snapshot, participação suficiente e nenhuma substituição indeterminada.
No histórico administrativo, a política temporal abaixo também permite avaliar
partidas presumidas, mantendo seus resultados PARCIAL e sem inferir ausência pela presunção.
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

### Recuperação administrativa com período vazio

Somente rodadas anteriores à rodada oficial atual usam a política de 150 minutos.
Partida válida com `periodo_tr` explicitamente vazio e `partida_data` válida recebe
`FINAL_PRESUMIDO` estritamente **após** o início previsto mais 150 minutos; exatamente
no limite permanece PENDENTE. Datas sem offset usam Brasília (UTC-03:00), sem depender
do fuso do servidor; datas com offset explícito respeitam esse offset. Período ausente,
data inválida e estados secundários preenchidos/ambíguos impedem a presunção, incluindo
andamento, adiamento, cancelamento ou interrupção. `F`/`POS_JOGO` válidos continuam
FINAL_CONFIRMADO, inclusive confirmações preservadas pelo fluxo existente.

A classificação é calculada na resposta, sem alterar `periodo_tr` persistido.
O mesmo motor recebe a política apenas para liberar sua verificação de término.
A participação continua usando as evidências originais: registros com
`entrou_em_campo: true/false` são explícitos; pontuação zero não indica ausência.
Omissão com partida presumida permanece desconhecida, mesmo com envelope completo
e cobertura do clube. A inferência existente requer término **confirmado**.

Resultados recuperados com alguma partida presumida permanecem PARCIAL, sem data
de consolidação. Se já existe resultado FINAL diferente, ele é preservado como
pendente até confirmação oficial. Repetição com mesma pontuação e substituições
não regrava nem sincroniza rankings. Confirmação posterior permite promoção a FINAL.
A presunção nunca comprova consolidação global e não altera o processamento automático,
a rodada atual, regras de capitão/Reserva de Luxo ou a rotina de competições.

### Participação histórica complementar

No administrativo histórico, somente times com participação ainda indeterminada
consultam `getTeamById(timeId, { round: rodada, forceRefresh: true })`, na rota oficial
`/time/id/:timeId/:rodada`. A resposta serve exclusivamente para participação em memória:
não substitui o snapshot, não importa trocas prontas e não fornece pontos para o cálculo.
Não utiliza `/time/substituicoes/:timeId`, cujo vínculo histórico não foi comprovado.

O contexto exige temporada oficial atual, rodada anterior disponível, snapshot da
mesma temporada/rodada e partidas dos clubes datadas nessa temporada. O mercado é
revalidado depois da consulta e antes de persistir. A resposta deve identificar o time
e declarar `rodada_atual` e `time.rodada_time_id` iguais à rodada solicitada. Uma temporada
declarada divergente também é rejeitada. Esses campos de rodada sozinhos não comprovam
temporada: a vinculação depende do contexto conjunto da fonte oficial atual, snapshot
e partidas. O endpoint não possui marcador de temporada independente; este fluxo não
autoriza consultas de temporadas anteriores nem promete uma garantia que a resposta
isolada não oferece.

Cada evidência aceita exige ID, clube, posição, papel titular/reserva e `rodada_id`
compatíveis com o snapshot, sem duplicação. Apenas `entrou_em_campo` booleano é aceito.
Atleta omitido, campo ausente, null ou zero não se tornam false. Conflito entre fontes
mantém o time pendente com ID e motivo, sem substituir o envelope persistido.
Participação true sem registro de pontuação no envelope também mantém pendência;
`pontos_num`, capitão e Reserva de Luxo retornados pela consulta histórica são ignorados.
Participação false não cria registro pontuado nem modifica pontos existentes.

O mesmo resolvedor recebe a participação composta. Falha de consulta ou validação
preserva o time e permite avaliar os demais; lock e contexto global ainda são verificados.
Quando a API histórica já apresenta papéis alterados por substituições, a divergência
com o snapshot bloqueia o aproveitamento: não se reconstrói a escalação original.
Resultados sob presunção continuam PARCIAL; FINAL divergente permanece protegido.
Uma repetição ainda pode precisar consultar participação novamente, pois o complemento
não é persistido, mas não regrava pontuação/substituições iguais nem sincroniza rankings.

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
