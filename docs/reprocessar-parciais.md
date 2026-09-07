# Reprocessamento administrativo de parciais

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
esses times mantêm os dados anteriores. Falha de persistência reverte a transação inteira.
`substituicoesAlteradas` conta relações ativadas/desativadas ou com posição corrigida
(trocar uma relação por outra conta duas alterações). Uma repetição com os mesmos
dados mantém pontuações e relações, retornando zero alterações de substituição.
Duração e horário variam a cada chamada.

Erros no formato padrão Nest (`statusCode`, `message`, `error`):

| HTTP | Motivo |
| --- | --- |
| 400 | Temporada/rodada ausente ou inválida |
| 401 | JWT ausente, inválido ou expirado |
| 403 | Usuário sem perfil ADMIN ou bloqueado |
| 404 | Rodada não encontrada em RodadaProcessamento |
| 409 | Rodada consolidada, processamento em andamento, lease perdido, snapshot ausente/incompleto ou envelope persistido indisponível/inválido |
| 500 | Falha inesperada de persistência/infraestrutura |

O backend não consulta o Cartola nem recria snapshots. Usa o último envelope
persistido e o mesmo RoundCalculator e upsert transacional do processamento automático.
Pontuações permanecem `PARCIAL`, com `consolidadoEm` nulo. No enum de
RodadaProcessamento, o estado correspondente é `EM_ANDAMENTO`; `PARCIAL` pertence
ao enum de pontuação. Escalações congeladas não são modificadas.

## Próxima tarefa do frontend

Exibir **Reprocessar parciais** somente para ADMIN na área administrativa.
Habilitar com temporada/rodada válidas e rodada existente não consolidada.
Desabilitar se houver processamento em andamento ou indisponibilidade conhecida de
snapshots/envelope. Se essas informações não estiverem disponíveis na tela, tratar
o 409 do backend como autoridade; não presumir disponibilidade.

Antes da chamada, confirmar com o texto:

> Todos os times da rodada serão recalculados usando as escalações já congeladas e os dados parciais disponíveis. A rodada continuará como parcial.

Durante a chamada, desabilitar o botão, mostrar loading e bloquear clique duplicado.
Após sucesso, mostrar times processados, substituições alteradas, erros e duração;
atualizar as parciais exibidas. Se houver erros individuais, indicar conclusão com
falhas. Restaurar o botão conforme o estado atual ao concluir ou receber erro.
O lock no servidor continua sendo a proteção contra concorrência entre usuários.

Nenhuma implementação de frontend faz parte desta alteração.
