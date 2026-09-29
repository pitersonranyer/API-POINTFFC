# Desafio — administração e partidas (Etapas 2 e 3)

Todas as rotas exigem `Authorization: Bearer <JWT>` de um `PLATFORM_ADMIN` ativo.
Reutilizam `JwtAuthGuard`, `AdminGuard` e `AuthenticatedUser` no `AdminModule`.
Os exemplos abaixo são ilustrativos; IDs e horários são gerados pelo servidor.

| Método | Rota | Sucesso |
| --- | --- | --- |
| POST | `/admin/desafios` | 201 |
| GET | `/admin/desafios` | 200 |
| GET | `/admin/desafios/:id` | 200 |
| PATCH | `/admin/desafios/:id` | 200 |
| POST | `/admin/desafios/:id/publicar` | 201 |
| POST | `/admin/desafios/:id/cancelar` | 201 |
| GET | `/admin/desafios/fixtures` | 200 |
| POST | `/admin/desafios/:id/partidas` | 201 |
| GET | `/admin/desafios/:id/partidas` | 200 |
| DELETE | `/admin/desafios/:id/partidas/:partidaId` | 200 |
| PATCH | `/admin/desafios/:id/partidas/ordem` | 200 |

Erros seguem as exceções HTTP do Nest: 400 para entrada/configuração inválida,
401 para autenticação ausente/inválida, 403 para perfil não autorizado/inativo,
404 para ID inexistente e 409 para operação incompatível com o status.
Os POSTs mantêm o status HTTP 201 padrão dos controllers administrativos.

## Contrato

- Campos utilizam os nomes da Etapa 1: `inicioInscricao`, `fimInscricao`, `dataInicio`, `dataFim`.
- Datas são strings ISO 8601 com horário e fuso (`Z` ou offset); respostas são UTC.
- `inicioInscricao < fimInscricao <= dataInicio < dataFim`.
- `valorInscricao` é texto decimal não negativo, com até duas casas e dez dígitos inteiros.
  A persistência usa `Prisma.Decimal`; a resposta usa `toFixed(2)`, como os recursos financeiros.
- FREE exige zero; PAGO exige valor positivo. Não há correção automática de valor.
- `nome` é obrigatório, sem ficar vazio após trim, com até 255 caracteres.
- `descricao` e `limiteParticipantes` aceitam `null`; limite informado deve ser inteiro entre 1 e 4294967295.
- PATCH aceita somente os campos de configuração e valida o estado final combinado com o registro atual.
  `null` em campos obrigatórios é rejeitado; omissão preserva o valor anterior.
- ID, status, criador, publicação e timestamps não são aceitos no body.
  O criador é obtido exclusivamente do contexto JWT. A resposta expõe apenas ID e nome do criador.
- Ações `publicar`/`cancelar` não recebem configuração; aceitam body ausente ou `{}`.

## Criar FREE

`POST /admin/desafios` — body:

```json
{
  "nome": "Desafio gratuito",
  "descricao": "Desafio de outubro",
  "tipoAcesso": "FREE",
  "valorInscricao": "0.00",
  "inicioInscricao": "2026-10-01T12:00:00Z",
  "fimInscricao": "2026-10-03T12:00:00Z",
  "dataInicio": "2026-10-03T12:00:00Z",
  "dataFim": "2026-10-04T23:00:00Z",
  "limiteParticipantes": null
}
```

Resposta 201 (formato completo também usado por consulta, edição e ações):

```json
{
  "id": 7,
  "nome": "Desafio gratuito",
  "descricao": "Desafio de outubro",
  "tipoAcesso": "FREE",
  "valorInscricao": "0.00",
  "status": "RASCUNHO",
  "inicioInscricao": "2026-10-01T12:00:00.000Z",
  "fimInscricao": "2026-10-03T12:00:00.000Z",
  "dataInicio": "2026-10-03T12:00:00.000Z",
  "dataFim": "2026-10-04T23:00:00.000Z",
  "limiteParticipantes": null,
  "criadoPorId": 42,
  "criadoPor": { "idUsuario": 42, "nome": "Admin" },
  "publicadoEm": null,
  "criadoEm": "2026-09-28T18:00:00.000Z",
  "atualizadoEm": "2026-09-28T18:00:00.000Z"
}
```

## Criar PAGO de R$ 2,00

`POST /admin/desafios` — body:

```json
{
  "nome": "Desafio R$ 2",
  "tipoAcesso": "PAGO",
  "valorInscricao": "2.00",
  "inicioInscricao": "2026-10-01T12:00:00Z",
  "fimInscricao": "2026-10-03T12:00:00Z",
  "dataInicio": "2026-10-03T12:00:00Z",
  "dataFim": "2026-10-04T23:00:00Z",
  "limiteParticipantes": 100
}
```

Resposta 201, no formato completo acima; trecho relevante:

```json
{ "id": 8, "nome": "Desafio R$ 2", "tipoAcesso": "PAGO", "valorInscricao": "2.00", "status": "RASCUNHO", "publicadoEm": null }
```

Nenhum débito ou pagamento é criado.

## Editar

`PATCH /admin/desafios/8` — body:

```json
{ "nome": "Desafio atualizado", "descricao": null, "limiteParticipantes": 200 }
```

Resposta 200, trecho:

```json
{ "id": 8, "nome": "Desafio atualizado", "descricao": null, "limiteParticipantes": 200, "tipoAcesso": "PAGO", "valorInscricao": "2.00", "status": "RASCUNHO" }
```

Um PATCH somente com `{"tipoAcesso":"FREE"}` nesse registro retorna 400.
Para converter para FREE, enviar também `"valorInscricao":"0.00"`.
Edição após publicação retorna 409.

## Publicar

`POST /admin/desafios/8/publicar` — body `{}`.

Resposta 201, trecho:

```json
{ "id": 8, "status": "ABERTO", "publicadoEm": "2026-09-28T18:05:00.000Z" }
```

Somente `RASCUNHO → ABERTO`. Revalida configuração completa e grava o horário atual.
Desde a Etapa 3, exige pelo menos uma partida válida e reconsulta todas as fixtures na football-data.org.
Cada partida deve estar agendada, sem resultado/gols apurados, com horário oficial futuro e dentro
do intervalo inclusivo `dataInicio <= horário da fixture <= dataFim`.
A identidade oficial (fixture, league, mandante e visitante) deve corresponder ao snapshot.
Uma mudança válida de horário atualiza o snapshot antes da publicação; mudança fora do período
rejeita a operação sem alterar automaticamente as datas do Desafio.

## Cancelar

`POST /admin/desafios/8/cancelar` — body `{}`.

Resposta 201, trecho:

```json
{ "id": 8, "status": "CANCELADO", "publicadoEm": "2026-09-28T18:05:00.000Z" }
```

Permite `RASCUNHO → CANCELADO` e `ABERTO → CANCELADO`.
Preserva `publicadoEm` e registros relacionados. Não exclui, não cancela inscrições e não movimenta carteira.
`EM_ANDAMENTO`, `ENCERRADO` e `CANCELADO` rejeitam cancelamento com 409.

## Listar e consultar

`GET /admin/desafios?pagina=1&limite=20&status=RASCUNHO&tipoAcesso=PAGO`

Filtros são opcionais. Defaults: página 1, limite 20; limite máximo 100.
Ordenação: `criadoEm DESC, id DESC`.
Resposta: `{"itens":[...],"paginacao":{"pagina":1,"limite":20,"total":1,"totalPaginas":1}}`.
Cada item tem a configuração completa demonstrada acima.

`GET /admin/desafios/8` retorna a configuração, sem partidas, palpites ou inscrições.

## Persistência e escopo

PATCH, publicação, cancelamento e alterações de partidas usam transação `ReadCommitted`
e o mesmo `SELECT ID FROM DESAFIO ... FOR UPDATE`, seguindo o padrão existente.
O próximo número de ordem, remoção/normalização e reordenação são calculados sob esse lock.
Adição e publicação consultam o fornecedor antes da transação e repetem as verificações internas
depois do lock. A publicação compara a composição atual com aquela revalidada externamente;
mudanças concorrentes retornam 409 e exigem nova tentativa. Configuração, status e horários são
verificados novamente sob lock. Atualizações dos snapshots e publicação são atômicas.

Não há mudanças no schema nem migration adicional nas Etapas 2/3. A migration `0019_desafio`
da Etapa 1 deve estar aplicada no ambiente que executará as rotas.
Não há DELETE de Desafio, endpoints públicos, palpites, inscrições, finanças ou jobs.
Só é possível excluir uma partida do rascunho, preservando a integridade dos registros relacionados.

## Integração football-data.org

O Desafio reutiliza FootballDataClient pelo FutebolModule, com FOOTBALL_DATA_API_TOKEN
no header X-Auth-Token e base https://api.football-data.org/v4.
Timeout: 15 segundos; intervalo mínimo entre chamadas: 6,5 segundos por instância.
Não há retry automático nem cache de publicação. IDs são consultados em lotes de até 50.

Os campos persistidos com sufixo ApiFootball são nomes legados do schema inicial;
nesta implementação armazenam exclusivamente IDs de football-data.org.
Não misture IDs dos dois fornecedores em registros existentes.

Referência: [documentação oficial](https://docs.football-data.org/general/v4/match.html).

## Buscar fixtures

Todas as consultas usam UTC. A pesquisa não persiste nada.

```http
GET /admin/desafios/fixtures?date=2026-10-03
GET /admin/desafios/fixtures?date=2026-10-03&league=71&season=2026
GET /admin/desafios/fixtures?date=2026-10-03&team=127&season=2026
GET /admin/desafios/fixtures?from=2026-10-01&to=2026-10-07&league=71&season=2026
```

Filtros: `date` OU `from` + `to` (máximo 7 dias inclusivos), `league`, `team`, `season`.
`league`/`team` exigem `season`, que representa o ano inicial da temporada.
Intervalos exigem `league` ou `team`. Não há busca de temporadas inteiras nem paginação local de fixtures.
Não é permitida combinação de `date` com `from`/`to`.

Resposta 200 ilustrativa (IDs de exemplo):

```json
[
  {
    "fixtureId": 123456,
    "leagueId": 71,
    "leagueNome": "Serie A",
    "dataHoraInicio": "2026-10-03T16:00:00.000Z",
    "mandanteId": 127,
    "mandanteNome": "Flamengo",
    "mandanteLogo": "https://media.api-sports.io/football/teams/127.png",
    "visitanteId": 121,
    "visitanteNome": "Palmeiras",
    "visitanteLogo": null,
    "horarioConfirmado": true,
    "statusInterno": "AGENDADA"
  }
]
```

A tradução dos status está centralizada no adaptador:

| football-data.org | Estado interno para validação |
| --- | --- |
| TIMED, SCHEDULED | AGENDADA |
| IN_PLAY, PAUSED, EXTRA_TIME, PENALTY_SHOOTOUT | EM_ANDAMENTO |
| FINISHED | FINALIZADA |
| POSTPONED, CANCELLED, SUSPENDED, AWARDED | ANULADA |
| desconhecido | null; não elegível |

Somente TIMED com horário estritamente futuro permite adição/publicação.
SCHEDULED não possui horário confirmado e é rejeitado nessas operações.
Esse mapeamento não sincroniza registros, não calcula resultados e não pontua partidas.

## Adicionar e listar partidas

```http
POST /admin/desafios/8/partidas
Content-Type: application/json

{"fixtureId":123456}
```

O backend consulta a fixture oficial. Campos esportivos/ordem enviados no body são rejeitados com 400.
Somente RASCUNHO é editável. Duplicidade no mesmo Desafio gera 409; a mesma fixture pode existir em outro.
A nova ordem é `MAX(ordem) + 1` (primeira = 1). Não há restrição a uma única competição.

Resposta 201 ilustrativa:

```json
{
  "id": 14,
  "desafioId": 8,
  "fixtureIdApiFootball": 123456,
  "leagueIdApiFootball": 71,
  "nomeCompeticao": "Serie A",
  "mandanteIdApiFootball": 127,
  "nomeMandante": "Flamengo",
  "logoMandanteUrl": "https://media.api-sports.io/football/teams/127.png",
  "visitanteIdApiFootball": 121,
  "nomeVisitante": "Palmeiras",
  "logoVisitanteUrl": null,
  "dataInicio": "2026-10-03T16:00:00.000Z",
  "status": "AGENDADA",
  "resultado": null,
  "golsMandante": null,
  "golsVisitante": null,
  "ordem": 1,
  "criadoEm": "2026-09-28T18:00:00.000Z",
  "atualizadoEm": "2026-09-28T18:00:00.000Z"
}
```

`GET /admin/desafios/8/partidas` retorna 200 com array desses snapshots em `ordem ASC, id ASC`.
O GET não reconsulta o fornecedor. Desafio inexistente retorna 404; Desafio sem partidas retorna `[]`.
As datas do Desafio podem ser ajustadas durante o rascunho; a validação definitiva do período ocorre ao publicar.

## Reordenar e remover

```http
PATCH /admin/desafios/8/partidas/ordem
Content-Type: application/json

{"partidaIds":[14,11,13,12]}
```

Exige todos os IDs internos atuais exatamente uma vez. Duplicatas, omissões e partidas externas geram 400.
Resposta 200 com snapshots completos na ordem solicitada. Trecho:

```json
[{"id":14,"ordem":1},{"id":11,"ordem":2},{"id":13,"ordem":3},{"id":12,"ordem":4}]
```

`DELETE /admin/desafios/8/partidas/11` remove a partida e renumera as restantes na mesma transação.
Resposta 200, trecho:

```json
[{"id":14,"ordem":1},{"id":13,"ordem":2},{"id":12,"ordem":3}]
```

Partida inexistente/pertencente a outro Desafio retorna 404. Palpites existentes impedem remoção com 409,
inclusive se forem dados de desenvolvimento. Depois da publicação, adicionar/remover/reordenar retorna 409.

## Falhas externas

- 404 com mensagem de **Fixture**: fornecedor respondeu com sucesso, mas o ID solicitado não existe.
- 502: resposta inesperada, identidade de ID retornado divergente, JSON inválido, falha de rede ou erro de consulta do fornecedor.
- 503: chave ausente, acesso indisponível, erro 5xx do fornecedor ou rate limit.
- 504: timeout do fornecedor.

Essas falhas não são convertidas em “404 Desafio” e não expõem API key, headers ou body bruto.
Uma identidade oficial diferente do snapshot armazenado gera 409 na publicação.
A publicação falha sem mudar snapshots/status se houver fixture inválida ou erro externo.

## Validação

```text
node_modules\.bin\prisma.cmd validate
npm.cmd run build
npm.cmd test -- --runInBand test/admin-desafio-partidas.service.spec.ts test/admin-desafio-partidas.controller.spec.ts test/admin-desafios.service.spec.ts test/admin-desafios.controller.spec.ts test/environment.validation.spec.ts
npm.cmd test -- --runInBand
git diff --check
```

O build inclui `prisma generate`. Os testes HTTP usam guards, decorators e ValidationPipe reais,
com autenticação e serviço simulados; os testes de serviço simulam Prisma e football-data.org.
Testes de publicação exercitam os dois services reais juntos. O client HTTP usa fetch mockado.
Testes de concorrência/rollback usam persistência simulada, não comprovam locks em MySQL real.
Nenhuma chamada real à football-data.org é necessária para os testes automatizados.
As integrações MySQL/Redis da suíte geral são opt-in conforme as variáveis já previstas pelo projeto.
