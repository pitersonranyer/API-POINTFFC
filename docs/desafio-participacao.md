# Participar do Desafio — Etapa 5

## Rota e confirmacao

`POST /desafios/:id/participar`, com `Authorization: Bearer <JWT>`.
Aceita body ausente ou `{}`. Campos adicionais sao rejeitados com 400.
Usuario vem exclusivamente do JWT e deve continuar ATIVO dentro da transacao.

Retorna 200 tanto para a criacao quanto para a repeticao de uma inscricao ATIVA:

```json
{
  "inscricao": {
    "id": 12,
    "desafioId": 7,
    "status": "ATIVA",
    "valorInscricao": "2.00",
    "dataInscricao": "2030-10-01T12:00:00.000Z"
  },
  "tipoAcesso": "PAGO",
  "valorCobrado": "2.00"
}
```

`valorCobrado` representa o snapshot da inscricao original, em BRL com duas casas;
na repeticao NAO significa uma nova cobranca. A resposta nao expoe usuarioId,
carteiraId, movimentacaoDebitoId, saldos anteriores ou metadados financeiros.
Nao e necessario enviar Idempotency-Key: a identidade da operacao e Desafio + usuario.

## Prazo e palpites obrigatorios

Para uma nova inscricao:

- Desafio publicado (`publicadoEm <= agora`) e com status `ABERTO`;
- `inicioInscricao <= agora < fimInscricao`;
- `agora < dataInicio` global e `agora < dataFim`;
- pelo menos uma partida nao anulada;
- todas as partidas nao anuladas devem estar `AGENDADA`, sem resultado/gols e com inicio futuro;
- todas essas partidas devem ter um palpite do proprio usuario, vinculado ao mesmo Desafio;
- quantidade de inscricoes ATIVA menor que limiteParticipantes, quando configurado.

Partidas ANULADA nao exigem palpite. Partida nao anulada que ja iniciou ou tem resultado
impede uma nova entrada, mesmo se os demais horarios ainda estiverem no futuro.
Igualdade no fimInscricao, inicio global ou inicio de partida ja fecha a entrada.
O backend revalida os prazos depois de esperar pelos locks e antes de concluir a transacao.

A confirmacao nunca cria/altera palpites. O fluxo independente da Etapa 4 permanece:
palpites podem ser marcados sem inscricao e alterados ate o inicio de cada partida,
inclusive depois do fechamento das novas participacoes.

## FREE e PAGO

FREE cria inscricao ATIVA com snapshot `0.00` e movimentacaoDebitoId nulo.
Nao acessa carteira nem registra movimento financeiro.

PAGO usa o valor atual do Desafio, validado como decimal positivo com ate duas casas.
Utiliza somente a carteira existente, ATIVA, e seu saldoDisponivel; saldoBloqueado nao financia a entrada.
Carteira inexistente equivale a saldo disponivel zero e nao e criada pelo endpoint.

Debito reutiliza `CarteiraService.debitarEmTransacao`:
tipo `DEBITO`, origem `INSCRICAO`, status `CONFIRMADA`, referencia
`desafio:<desafioId>:usuario:<usuarioId>`. O servico existente calcula os saldos anterior/posterior
e registra a movimentacao. O ID retornado preenche movimentacaoDebitoId da inscricao.
Nao ha escrita direta de saldo pelo servico de Desafio.

## Saldo insuficiente e erros

Exemplo de HTTP 409:

```json
{
  "statusCode": 409,
  "code": "SALDO_INSUFICIENTE",
  "message": "Adicione saldo a carteira para participar do Desafio.",
  "saldoDisponivel": "0.50",
  "valorNecessario": "2.00",
  "valorFaltante": "1.50",
  "moeda": "BRL"
}
```

O frontend pode oferecer o fluxo ja existente de adicionar saldo ao receber esse code.
O endpoint nao inicia PIX, nao cria recarga, inscricao ou movimentacao nesse caso.

Outros codigos 409:

| code | Significado |
| --- | --- |
| DESAFIO_INDISPONIVEL | Status/publicacao nao permite entrada |
| FORA_JANELA_INSCRICAO | Fora do prazo configurado |
| SEM_PARTIDAS_ELEGIVEIS | Nenhuma partida valida para compor o Desafio |
| PARTIDAS_INDISPONIVEIS | Partida nao anulada iniciada ou inelegivel |
| PALPITES_INCOMPLETOS | Resposta inclui `partidaIds` internos ainda sem palpite |
| LIMITE_PARTICIPANTES_ATINGIDO | Sem vagas |
| CARTEIRA_BLOQUEADA | Carteira nao ATIVA |
| VALOR_INSCRICAO_INVALIDO | Configuracao de valor incoerente |
| INSCRICAO_CANCELADA | Nao reativa inscricoes canceladas nesta etapa |
| INSCRICAO_DUPLICADA | Constraint final impediu duplicidade; consultar o Desafio |
| PARTICIPACAO_CONCORRENTE | Conflito/timeout transacional; repetir a solicitacao |

400: ID/body invalido. 401: JWT ausente/invalido. 403: usuario nao ativo.
404: Desafio/usuario inexistente. Falhas inesperadas abortam integralmente a transacao.

## Atomicidade, concorrencia e repeticao

Uma unica transacao `ReadCommitted` engloba validacoes, debito, movimento e inscricao.
Locks em ordem: `DESAFIO -> USUARIO -> CARTEIRA` (carteira apenas em PAGO).
O lock do Desafio serializa contagem de vagas, inscricoes e operacoes administrativas/palpites
das etapas anteriores. O lock do usuario/carteira serializa o saldo inclusive entre
desafios distintos e outros fluxos que usam CarteiraService.

Nao abre transacao financeira separada. Falha em qualquer escrita ou prazo ultrapassado
desfaz saldo, movimentacao e inscricao. Nao ha chamada externa dentro ou fora dessa operacao.
As constraints existentes Desafio + usuario e movimentacaoDebitoId unico permanecem intactas.

Inscricao ATIVA existente retorna seu snapshot antes de validar novas vagas/prazo/saldo;
assim, uma resposta perdida pode ser recuperada sem novo debito mesmo apos o fechamento.
Inscricao CANCELADA e recusada sem reativacao ou novo debito: estorno/reentrada nao fazem parte desta etapa.

## Detalhe autenticado

`GET /desafios/:id` continua publico e mantem `OptionalJwtAuthGuard`.
Somente quando autenticado, acrescenta:

```json
{
  "inscrito": true,
  "minhaInscricao": {
    "id": 12,
    "desafioId": 7,
    "status": "ATIVA",
    "valorInscricao": "2.00",
    "dataInscricao": "2030-10-01T12:00:00.000Z"
  }
}
```

Sem registro: `inscrito: false`, `minhaInscricao: null`.
Registro CANCELADA: `inscrito: false` e minhaInscricao com esse status.
Anonimo: os dois campos sao omitidos e nenhuma inscricao e consultada.
Consulta filtra exclusivamente Desafio + usuario do JWT. Regras de visibilidade da Etapa 4 permanecem.

## Validacao e escopo

Testes executam DesafioParticipacaoService e CarteiraService reais com persistencia simulada.
O simulador usa locks por Desafio/usuario/carteira e undo por transacao para intercalar
requisicoes concorrentes, incluindo desafios distintos. Nao comprova isolamento/locks em MySQL real.
HTTP usa controller, guards, ValidationPipe e servicos reais, com autenticacao/persistencia simuladas.
Nao requer chamadas reais a banco externo, fornecedor de futebol ou pagamento.

Nao altera Prisma nem migrations. Nao implementa PIX, recarga, apuracao, ranking,
premiacao, estorno ou jobs. Nao implementa a Etapa 6.
