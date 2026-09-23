# Inscricoes em lote FREE/PAGO

`POST /competicoes/:id/inscricoes/lote`, com JWT e `Idempotency-Key` obrigatoria
(16..128 caracteres: letras, numeros, hifen ou underscore).

```json
{
  "timesCartolaIds": [123, 456],
  "valorUnitarioEsperado": "10.00"
}
```

Aceita 1..50 IDs inteiros positivos distintos. `valorUnitarioEsperado` e opcional;
quando informado, exige string decimal nao negativa com duas casas. O servidor
sempre calcula o total a partir do preco vigente, relido sob lock.

Resposta 201 (inclusive replay):

```json
{
  "loteId": 1,
  "competicaoId": 7,
  "quantidade": 2,
  "tipoAcesso": "PAGO",
  "moeda": "BRL",
  "valorUnitario": "10.00",
  "valorTotal": "20.00",
  "movimentacaoDebitoId": 5,
  "saldoDisponivelAposOperacao": "80.00",
  "inscricoes": [
    { "id": 10, "timeIdCartola": 123, "statusInscricao": "ATIVA" },
    { "id": 11, "timeIdCartola": 456, "statusInscricao": "ATIVA" }
  ]
}
```

FREE retorna valores zero, movimentacao e saldo nulos; nao acessa a carteira.
O POST legado `/competicoes/:id/inscricoes` continua exclusivamente FREE.

## Idempotencia e transacao

A chave e armazenada como SHA-256 e escopada por usuario. O hash do pedido inclui
versao, competicao, IDs ordenados e preco esperado normalizado (ou null se ausente).
Mudar a ordem dos times nao muda a operacao; mudar preco esperado ou sua presenca muda.
Uma chave confirmada retorna `respostaOriginal`, mesmo se preco, saldo ou status da
competicao mudarem depois. O saldo da resposta e historico, nao uma consulta atual.
Mesmo depois de timeout, repetir a chave e seguro. Uma falha com rollback nao grava
a chave definitivamente. Nao substituir a chave ao repetir um resultado incerto.

O servico usa ReadCommitted e uma transacao por tentativa. A primeira leitura de
idempotencia permite replay sem exigir inscricoes abertas. Para nova operacao,
bloqueia competicao, usuario, vinculos TIME_USUARIO em ordem de ID e carteira.
Reconsulta a chave apos os locks; o usuario serializa tambem pedidos para competicoes
diferentes. CarteiraService recebe o mesmo TransactionClient, sem transacao aninhada.
As inscricoes sao criadas sequencialmente. O debito total ocorre uma unica vez.
Vinculos, somatorio e movimentacao sao relidos/validados antes de gravar resposta e
confirmacao. Toda excecao aborta a tentativa. Conflitos P2034/P2002 tem ate 3 tentativas.
Nao ha chamadas a provedores externos dentro da transacao.

## Erros 409

- `SALDO_INSUFICIENTE`: saldoDisponivel, valorNecessario, valorFaltante e moeda BRL.
- `PRECO_INSCRICAO_ALTERADO`: valorEsperado, valorAtual, quantidade e valorTotalAtual.
- `IDEMPOTENCY_KEY_REUTILIZADA`: mesma chave com outro conteudo.
- `CARTEIRA_BLOQUEADA`, `TIME_JA_INSCRITO`, limites e disponibilidade: nenhuma compra parcial.
- `INSCRICAO_CONCORRENTE`: repetir com a mesma chave.

Valores monetarios sao strings com duas casas. Falhas nao reservam saldo nem vagas.
Lote preexistente sem confirmacao retorna `LOTE_NAO_CONFIRMADO`; este fluxo nunca
confirma uma transacao deixando um lote incompleto.

## Implantacao e testes

Requer a migration 0018 da Fase 1. Nao ha migration adicional nesta fase.
Os testes reais `test/lotes-inscricao.integration.spec.ts` exigem
`CARTEIRA_TEST_DATABASE_URL` num MySQL dedicado, com 0018 ja aplicada. Eles nao
executam migrations e removem somente suas fixtures. Os testes em memoria nao
substituem a verificacao de locks/rollback real.

Propriedade significa vinculo em TIME_USUARIO, como no contrato existente. Estorno,
reinscricao apos cancelamento e Dashboard Financeiro permanecem fora desta fase.
