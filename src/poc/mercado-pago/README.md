# POC PIX Mercado Pago

Módulo NestJS removível, sem Prisma, banco, carteira, saldo, usuário real ou frontend. SDK oficial `mercadopago@3.6.0`, fixado no package/lockfile; compatível com Node >=18 (ambiente local verificado: 24.19.0).

## Configuração no Render

No serviço `api-pointffc`, abra **Environment**, adicione as variáveis abaixo e salve/reimplante. Insira os valores somente no painel; nunca no repositório, frontend ou logs.

```dotenv
MERCADO_PAGO_ACCESS_TOKEN=
MERCADO_PAGO_WEBHOOK_SECRET=
MERCADO_PAGO_POC_PAYER_EMAIL=
```

Use as credenciais de **teste** da aplicação Checkout Transparente e o secret da configuração de webhook dessa aplicação. `MERCADO_PAGO_POC_PAYER_EMAIL` é exclusivamente o e-mail do comprador de teste desta POC e deverá ser descartado junto com ela. Não tem vínculo com usuários do Fantasy Point nem é proposta para a integração definitiva.

As três variáveis são opcionais/vazias no startup geral. Criação, consulta de status e webhook retornam 503 com mensagem segura se a POC não estiver configurada; e-mail inválido também desabilita a POC. O health retorna 200 com `mercadoPagoConfigured: false`. A verificação é local, não comprova validade das credenciais no provedor.

O app principal continua com seu startup existente de Prisma/migrations e scheduler; **nenhuma operação da POC chama esses componentes**. Os testes da POC carregam apenas seu módulo e ConfigModule, sem banco.

## Rotas e contrato

| Método | Rota | Comportamento |
| --- | --- | --- |
| GET | `/poc/mercado-pago/health` | Saúde e presença de configuração, sem rede externa |
| POST | `/poc/mercado-pago/pix` | Cria Order PIX e registro em memória; retorna 201 |
| GET | `/poc/mercado-pago/pix/:id/status` | Consulta Order e retorna status/PIX atualizados; retorna 200 |
| POST | `/webhooks/mercado-pago` | Público, assinatura obrigatória, consulta Order e atualiza memória; retorna 200 |

São rotas públicas de POC, sem autenticação de usuário ou integração com carteira. O UUID interno identifica o recurso no polling. O body de criação aceita somente `valor`, número positivo com até duas casas, entre 0.01 e 10000 reais (limite local da POC). Campos extras, inclusive `usuarioId`, URLs e parâmetros externos, são rejeitados pela ValidationPipe global.

Criação e status retornam o mesmo formato:

```json
{
  "id": "c38e36fc-fb6a-4c44-a055-419c1ab60d0e",
  "idExterno": "ORD01JP84C939T20S0P1DN382FQ6K",
  "status": "PENDENTE",
  "valor": 10,
  "pix": {
    "copiaCola": "conteudo retornado pelo Mercado Pago",
    "qrCodeBase64": "imagem retornada pelo Mercado Pago",
    "expiracao": "2026-09-09T12:00:00Z"
  },
  "atualizadoEm": "2026-09-08T12:00:00Z"
}
```

Exemplo ilustrativo: valores de PIX não são códigos utilizáveis. `pix` pode ser `{}` na criação. Seus campos são opcionais e aparecem quando fornecidos pelo provedor; não é gerado QR fictício. `expiracao` vem de `transactions.payments[].date_of_expiration`, somente se presente. Não se inventa uma data a partir do relógio local. A resposta de sandbox pode conter `qr_code_base64` vazio; nesse caso o campo fica ausente.

O polling faz uma chamada `Order.get()` por requisição, compartilhada entre requisições concorrentes da mesma Order. Há timeout de rede de 5 segundos e limite de espera de 6 segundos incluindo o corpo da resposta, sem retries automáticos. Recomenda-se polling a cada 5 segundos e interrompê-lo ao terminar a sessão de teste. Se houver 502, tente consultar o mesmo ID posteriormente; falha de rede não muda o status armazenado para rejeitado.

## Criação de teste

Exemplos abaixo para bash. No PowerShell, use `curl.exe` e ajuste a continuação de linhas conforme seu terminal.

```bash
curl -i 'https://api-pointffc.onrender.com/poc/mercado-pago/health'

curl -i -X POST 'https://api-pointffc.onrender.com/poc/mercado-pago/pix' \
  -H 'Content-Type: application/json' \
  -d '{"valor":10.00}'

curl -i 'https://api-pointffc.onrender.com/poc/mercado-pago/pix/UUID_INTERNO_RETORNADO/status'
```

Guarde `id` para polling e `idExterno` para o painel. A referência enviada é `poc-pix-{uuid}` e a idempotency key é o mesmo UUID. O SDK usa `/v1/orders`, `type=online`, `processing_mode=automatic`, valor decimal em string e `payment_method={id:pix,type:bank_transfer}`. Cada POST novo gera uma nova referência: não há deduplicação de POSTs distintos do cliente.

O cenário oficial de teste utiliza `payer.first_name=APRO`, que esta POC envia fixamente, com o e-mail configurado. A documentação informa que a Order começa aguardando transferência e é atualizada automaticamente para aprovada. Não é necessário efetuar transferência bancária real para validar esse cenário. [Teste PIX oficial](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix)

## Webhook no painel

1. Em **Suas integrações**, selecione a aplicação Checkout Transparente correspondente às credenciais.
2. Em **Webhooks > Configurar notificações**, configure `https://api-pointffc.onrender.com/webhooks/mercado-pago` e o evento **Order (Mercado Pago)**. Siga a aba indicada pelo painel para essa integração; a documentação de Orders atualmente mostra a aba Modo de produção, embora a simulação possa enviar `live_mode=false`.
3. Salve e configure o secret gerado em `MERCADO_PAGO_WEBHOOK_SECRET` no Render.
4. Crie o PIX pela POC. Clique em **Simular**, selecione o evento Order e use seu **idExterno real** como Data ID. Um ID inventado não poderá ser consultado pela Orders API.
5. Envie o teste e confira a resposta HTTP, logs seguros e GET de status. O endpoint não acredita no status do simulador: o status só muda se `Order.get()` devolver uma mudança real.

O SDK oficial `WebhookSignatureValidator` valida `x-signature`, `x-request-id`, `data.id` **da query** e o secret. Não há implementação própria do HMAC. O corpo não é usado para selecionar recurso ou estado. Notificações sem `data.id` válido retornam 400; assinatura inválida retorna 401; falha da API retorna 502 para permitir reenvio. O ACK 200 ocorre após a consulta limitada, não há tarefa de rede abandonada após confirmar o webhook. [Notificações oficiais](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications)

Teste negativo local/remoto, sem assinatura (deve retornar 401):

```bash
curl -i -X POST \
  'https://api-pointffc.onrender.com/webhooks/mercado-pago?data.id=ORD01JP84C939T20S0P1DN382FQ6K&type=order' \
  -H 'Content-Type: application/json' \
  -d '{"type":"order"}'
```

Para testar assinatura válida, prefira o simulador oficial; a suíte também exercita o validador real do SDK com assinaturas de teste e API simulada.

## Estado e status

Dois Maps indexam UUID -> registro e Order ID -> UUID. Um terceiro reúne consultas em andamento. Webhooks duplicados não criam registros e repetir estado/PIX não altera `atualizadoEm`. Respostas com versão anterior de `last_updated_date` são ignoradas quando há timestamps disponíveis. ID, referência e valor são conferidos antes de aplicar atualizações. Webhook válido para Order ausente da memória é consultado e reconhecido sem recriar transação.

| Order status/detail | Estado interno |
| --- | --- |
| created, processing | PROCESSANDO |
| action_required | PENDENTE |
| processed / accredited | APROVADO |
| canceled | CANCELADO |
| expired | EXPIRADO |
| failed | REJEITADO (processing_error -> ERRO) |
| refunded | REEMBOLSADO |
| processed / partially_refunded | REEMBOLSADO_PARCIALMENTE |
| charged_back | CONTESTADO |
| desconhecido ou processed sem detalhe reconhecido | ERRO |

O mapeamento é centralizado em `mercado-pago-status.ts`; reembolso/contestação não dispara efeito financeiro. [Status oficiais](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status)

## Limitações e remoção

- **Deploy, restart e reciclagem da instância Render apagam os Maps.** O polling desses IDs retorna 404. É esperado nesta POC.
- Múltiplas instâncias não compartilham registros; executar a POC em uma instância. Não há persistência, fila durável, limpeza por TTL ou recuperação de transações.
- Timeout de criação pode ocorrer após a Order ter sido criada remotamente; não se deve repetir POST cegamente. Não há reconciliação de criação incerta nesta fase.
- Retorno do health não confirma credenciais, permissões, chave PIX ou entrega do webhook. A validação real depende da configuração da conta e do deploy.
- Logs contêm apenas IDs, eventos e transições, sem payload externo, credenciais, e-mail, QR ou copia e cola.
- O SDK pode concluir internamente uma resposta tardia após o limite de espera; ela não altera a memória porque a operação da POC já falhou.
- Não usar como integração financeira definitiva: endpoints públicos, estado volátil, comprador fixo de teste e ausência de controle de saldo são deliberados nesta POC.

Para remover: excluir `src/poc/mercado-pago`, retirar `PocMercadoPagoModule` do AppModule, remover as três variáveis do schema/exemplo/Render, desinstalar `mercadopago` e desativar o webhook no painel. Não há migration a reverter.

## Testes

```bash
npm test -- --runInBand src/poc/mercado-pago/poc-mercado-pago.spec.ts
npm test -- --runInBand
npm run lint
npm run typecheck
npm run build
```

Os testes iniciam somente o módulo da POC em porta local temporária e simulam a API externa. Incluem validação de valores/campos extras, QR assíncrono, configuração ausente, status, IDs desconhecidos, assinatura válida/inválida, duplicidade, aprovação, falhas, concorrência, timeout, transporte do SDK e mapeamento de status.

Validação executada nesta implementação: 43 testes da POC aprovados; suíte completa com 25 suítes e 270 testes aprovados, 5 suítes/7 testes ignorados pela configuração existente. Lint, typecheck, build e `git diff --check` aprovados. Não houve deploy, chamada autenticada real ao Mercado Pago ou teste no painel/Render; essa etapa depende das credenciais e da implantação, conforme o roteiro acima.
