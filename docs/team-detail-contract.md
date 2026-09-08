# Detalhe do time e escalação efetiva

Endpoint existente: `GET /cartola/times/:timeId?temporada=2026&rodada=25`.
O consumidor atual foi localizado em `UI-POINTFFC/src/services/cartola/cartola.service.ts` (`buscarEscalacaoTime`). Nenhum frontend foi modificado.

Os filtros são opcionais. Sem filtros, seleciona a rodada mais recente de `RodadaProcessamento` (temporada e rodada decrescentes). Para uma tela de rodada específica, envie ambos. A seleção não consulta o status do mercado no Cartola.

O contrato tipado completo está em `src/cartola/team-detail-response.ts` (`TeamDetailResponse`). São mantidos os nomes e a composição original de `atletas`, `reservas`, `capitao_id`, `reserva_luxo_id`, `time`, `patrimonio`, `esquema_id`, `pontos` e `rodada_atual`. Metadados são obtidos do snapshot e de `TimeCartola`; fotos só estão disponíveis quando presentes nos pontuados persistidos. Campos opcionais exclusivos do payload externo, como ranking, não são reconstruídos.

## Campos adicionados

| Local | Campo | Significado |
| --- | --- | --- |
| Raiz | `timeRodadaId`, `temporada`, `status` | Identificação do snapshot e status PARCIAL ou FINAL |
| Raiz | `substituicoes` | Somente registros com `ativa=true` |
| Substituição | `titularSaiuId`, `reservaEntrouId` | IDs dos atletas que saíram e entraram |
| Substituição | `ativa` | Sempre true nesta representação |
| Substituição | `reservaLuxo` | Quem entrou é o atleta designado por `TimeRodada.reservaLuxoId` |
| Substituição | `herdouCapitao` | Capitão efetivo fornecido pela projeção existente do motor |
| Atleta, nos dois arrays | `titularEfetivo` | Pertence à escalação contabilizada, incluindo técnico |
| Atleta | `capitaoOriginal`, `capitaoEfetivo` | Capitão antes e depois das substituições persistidas |
| Atleta | `reservaLuxo`, `reservaLuxoUtilizado` | Designação original; designado entrou em uma substituição ativa |
| Atleta | `pontuacaoContabilizada` | Contribuição efetiva, com multiplicador e arredondamento; zero fora da escalação efetiva |

`pontos_num` é a pontuação individual, sem multiplicador. `pontos` é o total de `PontuacaoTimeRodada`, sem recomputar o total no endpoint. Pontuação individual ausente usa zero, seguindo o motor existente; `entrou_em_campo` permanece null quando desconhecido.

Não existe enum nem motivo persistido em `SubstituicaoTimeRodada`. Por isso não foi criado `tipo`: `reservaLuxo` fornece a identificação existente no domínio. Esse booleano **não distingue** entrada normal do reserva designado de entrada pela comparação de pontuação da regra de luxo. Essa distinção exigiria persistir informação adicional no processamento, fora do escopo autorizado.

## Exemplo verificado

Recorte JSON do cenário de teste FINAL, reserva 456 entrando pelo capitão 123. É uma fixture de teste, não dado consultado em produção:

```json
{
  "timeRodadaId": 1,
  "temporada": 2026,
  "rodada_atual": 25,
  "status": "FINAL",
  "pontos": 12.6,
  "capitao_id": 123,
  "reserva_luxo_id": 456,
  "substituicoes": [
    { "ativa": true, "titularSaiuId": 123, "reservaEntrouId": 456, "reservaLuxo": true, "herdouCapitao": true }
  ],
  "atletas": [
    { "atleta_id": 123, "nome": "Pedro", "pontos_num": 8.4, "titularEfetivo": false, "capitaoOriginal": true, "capitaoEfetivo": false, "reservaLuxo": false, "reservaLuxoUtilizado": false, "pontuacaoContabilizada": 0 }
  ],
  "reservas": [
    { "atleta_id": 456, "nome": "Calleri", "pontos_num": 8.4, "titularEfetivo": true, "capitaoOriginal": false, "capitaoEfetivo": true, "reservaLuxo": true, "reservaLuxoUtilizado": true, "pontuacaoContabilizada": 12.6 }
  ]
}
```

## Consumo pelo frontend

Una `atletas` e `reservas` por `atleta_id` para obter o elenco original, sem criar cópias. Separe a visualização efetiva por `titularEfetivo`. Use os pares em `substituicoes` para os textos de entrada/saída. Exiba C por `capitaoEfetivo`, estrela por `reservaLuxo` e pontos por `pontuacaoContabilizada`. Não aplique multiplicador nem escolha substitutos. Preserve `capitao_id` para uma visualização original.

## Fonte e compatibilidade

A leitura de rodada, escalação, substituições ativas, metadados e total ocorre em transação MySQL RepeatableRead, sem consultas por atleta. Reutiliza `effectiveLineup`, `scoreMap` e `totalScore` já existentes, sem modificar RoundCalculator ou duplicar decisões de substituição, capitão ou multiplicador. As contribuições individuais não estão persistidas separadamente: são projetadas pelo motor existente sobre os pontuados persistidos da rodada.

PARCIAL e FINAL usam o mesmo caminho, sem Cartola, cache externo ou reconstrução histórica. Snapshot encontrado sem pontuados/total retorna 503. Histórico consolidado sem time retorna 404. Consulta explícita sem snapshot retorna 404, sem fallback externo.

Para preservar a consulta legada de times ainda não capturados, somente a consulta **sem filtros**, sem snapshot e fora de histórico consolidado mantém o fallback Cartola existente. Esse payload não recebe informações efetivas inventadas. Ausência de `substituicoes` significa contrato legado indisponível; `substituicoes: []` significa snapshot processado sem substituições ativas.

O total persistido é a referência para o time. A soma dos valores individuais exibidos pode diferir por arredondamento, pois o motor arredonda o total após somar e o contrato exibe cada contribuição com duas casas decimais.

## Validação executada

- Suíte completa: 24 suítes aprovadas, 225 testes aprovados; 5 suítes/7 testes ignorados pela configuração existente.
- Após os últimos ajustes: 32 testes aprovados em `team-detail.spec.ts` e `cartola.controller.spec.ts`, incluindo dois testes adicionais.
- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd run build`: aprovado (Prisma generate e Nest build).
- `git diff --check`: aprovado.

Os testes de consulta usam Prisma e HTTP simulados; não houve validação em MySQL de produção. RoundCalculator, processamento, scheduler, reconciliação, snapshots, autenticação e frontend não foram alterados.
