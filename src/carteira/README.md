# Webhook produtivo de Orders — Mercado Pago

Endpoint: `POST /webhooks/mercado-pago/carteira`.

## Assinatura e identificação da Order

O controller extrai `x-signature` e `x-request-id` dos headers e `data.id`
da query string. O body não é usado para calcular a assinatura.

O ID alfanumérico da Order chega em maiúsculas (`ORD...`). Para validar a
assinatura, sua representação deve ser convertida para lowercase exclusivamente
no argumento enviado ao `WebhookSignatureValidator`:

```ts
dataId: dataId.toLowerCase()
```

O ID original não deve ser modificado: permanece em maiúsculas nas validações,
na consulta oficial da Order, na identificação da recarga, nos logs e no
processamento. Remover esse lowercase da chamada ao validador pode provocar
HTTP 401 em notificações produtivas de Orders.

## Fluxo preservado

O webhook valida a assinatura, consulta a Order pela API oficial, localiza a
recarga e valida ID, externalReference, valor e provedor antes de aplicar o
resultado. A aprovação, o crédito e a movimentação permanecem no processamento
transacional existente, com idempotência. O HTTP 200 é enviado após a conclusão;
uma Order sem recarga vinculada é ignorada e também recebe HTTP 200.

## Logs operacionais

- `WEBHOOK_CARTEIRA_PROCESSADA` (`log`/info): conclusão, ID original da Order,
  ID da recarga e status resultante. Não significa necessariamente novo crédito:
  a idempotência continua sendo aplicada pelo processamento existente.
- `WEBHOOK_CARTEIRA_IGNORADO` (`warn`): Order sem recarga vinculada.
- `WEBHOOK_CARTEIRA_ERRO` (`error`): etapa da falha, status HTTP, categoria e
  identificadores disponíveis, sem mensagem bruta da exceção.

Esses registros não incluem tokens, secret, assinatura, QR Code, Pix copia e
cola, payload completo nem dados pessoais. Valores inesperados de status e IDs
inválidos não são expostos nos logs.

## Regressão

Os testes do client e do serviço cobrem HMAC lowercase com entrada uppercase,
assinaturas inválidas e preservação do ID original após a validação. Os testes
do controller verificam query versus body e respostas HTTP. Os testes de
carteira/recarga preservam a cobertura de processamento e idempotência; as
suítes MySQL exigem `CARTEIRA_TEST_DATABASE_URL` apontando para banco de teste.
