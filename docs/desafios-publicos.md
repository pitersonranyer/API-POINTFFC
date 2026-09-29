# Desafio publico e palpites — Etapa 4

A [Etapa 5](desafio-participacao.md) acrescenta a confirmacao de participacao e os campos
`inscrito`/`minhaInscricao` no detalhe autenticado, preservando a independencia dos palpites.

## Rotas

| Metodo | Rota | Autenticacao | Sucesso |
| --- | --- | --- | --- |
| GET | `/desafios` | Publica | 200 |
| GET | `/desafios/:id` | JWT opcional | 200 |
| PUT | `/desafios/:id/partidas/:partidaId/palpite` | JWT obrigatorio | 200 (criar ou alterar) |

`id` e `partidaId` sao IDs internos, inteiros positivos de ate 4294967295.
`partidaId` nao e o identificador do fornecedor de futebol.

## Visibilidade e disponibilizacao

Listagem e detalhe usam a mesma regra, com horario UTC do backend:

- status `ABERTO` ou `EM_ANDAMENTO`;
- `publicadoEm` preenchido e menor ou igual ao instante atual;
- `inicioInscricao <= agora < dataFim`.

O schema nao possui um periodo separado de exibicao. Por isso, `inicioInscricao`
marca a disponibilizacao publica e `dataFim` encerra essa disponibilizacao.
Rascunhos, cancelados, encerrados, nao publicados, ainda nao disponiveis e expirados
nao aparecem na listagem e retornam 404 no detalhe, inclusive para administradores.
As rotas administrativas das etapas anteriores continuam disponiveis separadamente.

`fimInscricao` e `dataInicio` global sao informativos nesta etapa e NAO fecham palpites.
Um Desafio `EM_ANDAMENTO` continua aceitando palpites nas partidas futuras elegiveis.
Nao ha job novo nem transicao automatica de status nesta etapa.

## Listagem

`GET /desafios?pagina=1&limite=20&tipoAcesso=PAGO`

Filtros opcionais: pagina (padrao 1), limite (padrao 20, maximo 100) e tipoAcesso (`FREE`/`PAGO`).
Nao aceita filtros por usuario nem por status privado. Ordenacao: `dataInicio ASC, id ASC`.

Formato: `{ "itens": [...], "paginacao": { "pagina": 1, "limite": 20, "total": 1, "totalPaginas": 1 } }`.
Cada item tem os dados principais do exemplo de detalhe, sem `partidas`.
Valores monetarios sao strings decimais com duas casas; datas sao ISO 8601 em UTC.

## Detalhe e autenticacao opcional

Reutiliza `OptionalJwtAuthGuard`, como `GET /competicoes/:id/resumo`:
sem Authorization, o detalhe e publico; com header, o JWT deve ser valido.
JWT invalido/expirado ou header malformado retorna 401, sem fallback anonimo.
Usuario bloqueado retorna 403, conforme `JwtAuthGuard`.

`GET /desafios/7`, com `Authorization: Bearer <JWT>`:

```json
{
  "id": 7,
  "nome": "Desafio do dia",
  "descricao": null,
  "tipoAcesso": "PAGO",
  "valorInscricao": "2.00",
  "status": "EM_ANDAMENTO",
  "inicioInscricao": "2030-10-01T00:00:00.000Z",
  "fimInscricao": "2030-10-03T10:00:00.000Z",
  "dataInicio": "2030-10-03T11:00:00.000Z",
  "dataFim": "2030-10-04T23:00:00.000Z",
  "partidas": [
    {
      "id": 1,
      "ordem": 1,
      "nomeCompeticao": "Serie A",
      "nomeMandante": "Mandante",
      "logoMandanteUrl": "https://example.com/home.png",
      "nomeVisitante": "Visitante",
      "logoVisitanteUrl": null,
      "dataInicio": "2030-10-03T16:00:00.000Z",
      "status": "AGENDADA",
      "fechamentoEm": "2030-10-03T16:00:00.000Z",
      "podeAlterarPalpite": true,
      "meuPalpite": "CASA"
    }
  ]
}
```

Partidas ordenadas por `ordem ASC, id ASC`. Escudos ausentes sao `null`.
Autenticado: `meuPalpite` e `CASA`, `EMPATE`, `FORA` ou `null` quando ainda nao marcou.
Somente os palpites do JWT sao consultados, mesmo sem inscricao. Palpites de partidas
fechadas continuam visiveis enquanto o Desafio estiver disponivel.
Anonimo: `meuPalpite` e omitido, `podeAlterarPalpite` e `false` e nenhum palpite e consultado.
O detalhe envia `Cache-Control: private, no-store` por poder conter dados pessoais.
Nao expoe criador, IDs do fornecedor, usuarioId, IDs internos de palpites ou campos de apuracao.

## Salvar/alterar meu palpite

```http
PUT /desafios/7/partidas/1/palpite
Authorization: Bearer <JWT>
Content-Type: application/json

{"palpite":"EMPATE"}
```

```json
{
  "desafioId": 7,
  "partidaId": 1,
  "palpite": "EMPATE",
  "fechamentoEm": "2030-10-03T16:00:00.000Z",
  "podeAlterarPalpite": true
}
```

O body aceita somente `palpite` com um dos tres valores em maiusculas.
Identidade vem exclusivamente do JWT. Campos extras como usuarioId, pontos,
apurado ou fechamentoEm sao rejeitados com 400 pelo ValidationPipe.
Nao e necessario preencher outras partidas, possuir inscricao ou saldo, inclusive em Desafio PAGO.

Aceita gravacao somente em Desafio disponivel e partida `AGENDADA`, sem resultado/gols
preenchidos e com `agora < partida.dataInicio`. Exatamente no inicio ja retorna 409.
Partidas anuladas, em andamento e finalizadas nao aceitam gravacao mesmo com data futura.
O frontend usa `fechamentoEm` para exibicao; `podeAlterarPalpite` reflete o instante da consulta.
O PUT sempre revalida no servidor, portanto uma tela antiga pode receber 409.

Gravacao usa transacao `ReadCommitted`: bloqueia primeiro DESAFIO (mesma ordem dos
servicos administrativos), depois a partida vinculada. Le estado e horario apos os locks.
Faz upsert pela constraint existente `[desafioPartidaId, usuarioId]`; ao atualizar,
altera somente o valor do palpite. Revalida o horario depois da escrita e desfaz a
transacao se a operacao atravessar o fechamento. Palpites de outros usuarios sao preservados.
As rotas publicas usam snapshots locais, sem consulta ao fornecedor de futebol.

Erros: 400 para parametros/body invalidos; 401 para JWT ausente no PUT ou invalido;
403 para usuario bloqueado; 404 para Desafio/partida inexistente, partida de outro Desafio
ou detalhe indisponivel; 409 no PUT quando o Desafio nao permite participacao ou a partida esta fechada/inelegivel.

## Escopo e validacao

Nao altera schema, constraints nem migrations. O fluxo de palpites nao consulta/cria DesafioInscricao,
nao movimenta carteira, nao integra PIX/pagamento e nao implementa ranking/apuracao.
Desde a Etapa 5, o detalhe autenticado consulta a propria inscricao e ha uma rota separada de participacao.
Nenhum palpite cria automaticamente uma inscricao, nem mesmo em Desafio FREE.

Testes de servico cobrem visibilidade, periodos, privacidade, criacao/alteracao, igualdade
no fechamento, partidas futuras, estados inelegiveis e ausencia de acesso financeiro.
Concorrencia/rollback sao simulados; nao comprovam locks em MySQL real.
Testes HTTP usam guards, decorators e ValidationPipe reais, com AuthService e DesafiosService simulados.

```text
npm.cmd run build
npm.cmd test -- --runInBand test/desafios.service.spec.ts test/desafios.controller.spec.ts test/admin-desafios.service.spec.ts test/admin-desafios.controller.spec.ts test/admin-desafio-partidas.service.spec.ts test/admin-desafio-partidas.controller.spec.ts
npm.cmd test -- --runInBand
node_modules\.bin\eslint.cmd src/app.module.ts src/desafios test/desafios.service.spec.ts test/desafios.controller.spec.ts --ext .ts
git diff --check
```
