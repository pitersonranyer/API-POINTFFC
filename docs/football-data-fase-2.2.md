# Futebol — Fase 2.2: vínculo BSA com clubes Cartola

## 1–3. Investigação do fluxo atual e identificadores

A inspeção foi realizada antes de modificar schema ou código.

- O backend expõe GET /cartola/dashboard, /cartola/partidas e /cartola/partidas/:rodada.
- As partidas Cartola usam partida_id, clube_casa_id e clube_visitante_id (src/cartola/cartola.types.ts).
- Clubes são objetos indexados pelo ID Cartola, com campo id. CartolaService.getClubs() obtém /clubes através de CartolaHttpClient e CartolaCacheService, com TTL de 18 horas.
- Não há tabela persistente apropriada de clubes Cartola. TimeCartola representa times fantasy/cartoleiros, não clubes profissionais, portanto não serve como FK.
- clube_id existe nos atletas do provedor. EscalacaoTimeRodada.clubeId / CLUBE_ID o preserva nos snapshots; JSONs de RodadaProcessamento também guardam partidas e atletas pontuados.
- Não foi encontrado vínculo reaproveitável entre IDs football-data e Cartola.
- No frontend existente, MatchDetailsPage localiza a partida pelo partida_id do dashboard, obtém os dois clubes e filtra atletas por atleta.clube_id === partida.clube_casa_id ou clube_visitante_id.
- useCartolaDashboard utiliza buscarAtletasPontuados() ou buscarAtletasPontuadosRodada(rodada - 1), conforme o mercado. MatchDetailsPage só exibe esses atletas quando o mercado está fechado.
- Os endpoints são GET /cartola/atletas/pontuados e GET /cartola/atletas/pontuados/:rodada (query temporada opcional no backend), delegados a CartolaService.getScoredAthletes().
- Não existe hoje endpoint de atletas que receba clubeId e filtre no servidor. O contrato atual retorna a coleção com clube_id; o consumidor filtra por igualdade numérica. Não foi criado endpoint novo.
- GET /cartola/atletas/mercado / CartolaService.getMarketAthletes() também retorna atletas com clube_id, mas não é o caminho utilizado pela página atual para mostrar pontuados.

Arquivos do frontend foram apenas lidos: src/components/matches/MatchDetailsPage.tsx, src/hooks/useCartolaDashboard.ts e src/services/cartola/cartola.service.ts.

## 4–6. Modelagem e escopo

FutebolTime.cartolaClubeId mapeia CARTOLA_CLUBE_ID, INTEGER UNSIGNED NULL.
Não há FK porque não existe entidade persistente adequada de clubes Cartola.
Não foi criada tabela redundante, constraint obrigatória ou índice sem uso.

O helper vinculoCartola(codigo, externalId) retorna imediatamente sem resolver IDs quando codigo não é BSA.
A sincronização BSA usa a associação explícita; não faz comparação por nome, sigla ou slug.
O mapper de respostas retorna null em qualquer competição não-BSA, mesmo se o clube global também tiver vínculo BSA.
Isso impede que o enriquecimento seja apresentado como integração de outras competições.
A persistência não-BSA com null foi validada no MySQL em transação revertida.

## 7. Arquivos criados

- src/futebol/futebol-cartola.ts
- prisma/migrations/0015_futebol_cartola_clube/migration.sql
- test/futebol-cartola.spec.ts
- test/futebol-cartola.integration.spec.ts
- docs/football-data-fase-2.2.md

## 8. Arquivos alterados

- prisma/schema.prisma
- src/futebol/futebol-sync.service.ts
- src/futebol/futebol-query.service.ts
- src/futebol/dto/futebol-response.dto.ts
- test/futebol.spec.ts
- test/futebol-query.spec.ts

## 9. Migration

0015_futebol_cartola_clube aplicada com sucesso no MySQL local.
Adiciona campo nullable e preenche IDs explicitamente apenas para clubes associados a partidas BSA persistidas.
0013 e 0014 não foram alteradas. Dados, nomes originais/amigáveis e escudos foram preservados.

## 10–11. Mapeamento completo e origem

Fonte: respostas reais dos recursos /clubes e /atletas/mercado da API Cartola configurada no projeto, consultadas em 2026-09-11.
IDs, slugs e editorias foram conferidos administrativamente para resolver ambiguidades de siglas.
Os mesmos recursos já são consumidos por CartolaService.getClubs()/getMarketAthletes().
Nenhuma dessas informações textuais é usada na resolução em runtime.

| footballDataExternalId | Nome PointFFC | cartolaClubeId |
| --- | --- | --- |
| 1765 | Fluminense | 266 |
| 1766 | Atlético-MG | 282 |
| 1767 | Grêmio | 284 |
| 1768 | Athletico-PR | 293 |
| 1769 | Palmeiras | 275 |
| 1770 | Botafogo | 263 |
| 1771 | Cruzeiro | 283 |
| 1772 | Chapecoense | 315 |
| 1776 | São Paulo | 276 |
| 1777 | Bahia | 265 |
| 1779 | Corinthians | 264 |
| 1780 | Vasco | 267 |
| 1782 | Vitória | 287 |
| 1783 | Flamengo | 262 |
| 4241 | Coritiba | 294 |
| 4286 | Bragantino | 280 |
| 4287 | Remo | 364 |
| 4364 | Mirassol | 2305 |
| 6684 | Internacional | 285 |
| 6685 | Santos | 277 |

Todos os 20 foram determinados com segurança; nenhum ficou sem mapping.

## 12–14. Desconhecidos e sobrevivência à sincronização

- Novo clube BSA sem mapping: criação com null, carga continua, sem inferência textual.
- Se um vínculo administrativo já existir para um ID fora do mapa, updates omitem esse campo e o preservam.
- IDs conhecidos recebem o vínculo canônico do mapa BSA em cada sincronização.
- Fora de BSA: helper não tenta resolver IDs nem gera warnings; criação pode usar null, updates não apagam vínculos de uma eventual participação BSA.
- Não há chamadas Cartola durante a sincronização football-data; o vínculo vem do mapa local explícito.
- Duas execuções reais de npm run futebol:sync mantiveram os 20 vínculos e a idempotência.

## 15. DTOs e respostas

FutebolTimeResponseDto ganhou cartolaClubeId: number | null, documentado no Swagger.
O campo é selecionado junto a mandante/visitante em:
- GET /futebol/competicoes/:codigo/jogos
- GET /futebol/competicoes/:codigo/rodadas/:rodada
- GET /futebol/competicoes/:codigo/rodada-atual

GET /futebol/competicoes permanece sem dados Cartola.
Não foram adicionados atletas, parciais, escalações ou outro payload ao endpoint de jogos.

## 16. Resposta real

Validação HTTP local com MySQL real em 2026-09-11T13:25:57.899Z, com fetch externo bloqueado.
Os três endpoints afetados retornaram HTTP 200:
rodada-atual → rodada 27 / 10 jogos; rodadas/27 → 10 jogos; jogos?temporada=2026 → 380 jogos.

Trecho real de GET /futebol/competicoes/BSA/rodada-atual (um dos 10 jogos; o envelope tem total=10):

```json
{
  "id": 268,
  "externalId": 555005,
  "temporada": 2026,
  "rodada": 27,
  "fase": "REGULAR_SEASON",
  "grupo": null,
  "dataHoraUtc": "2026-09-13T20:30:00.000Z",
  "status": "TIMED",
  "vencedor": null,
  "mandante": {
    "id": 14,
    "externalId": 1783,
    "cartolaClubeId": 262,
    "nome": "Flamengo",
    "nomeCurto": "Flamengo",
    "sigla": "FLA",
    "escudoUrl": "https://crests.football-data.org/1783.png"
  },
  "visitante": {
    "id": 11,
    "externalId": 1779,
    "cartolaClubeId": 264,
    "nome": "Corinthians",
    "nomeCurto": "Corinthians",
    "sigla": "COR",
    "escudoUrl": "https://crests.football-data.org/1779.png"
  },
  "placar": { "mandante": null, "visitante": null },
  "placarIntervalo": { "mandante": null, "visitante": null }
}
```

Outros clubes confirmados na mesma resposta real:

```json
[
  { "nome": "Atlético-MG", "externalId": 1766, "cartolaClubeId": 282 },
  { "nome": "Fluminense", "externalId": 1765, "cartolaClubeId": 266 },
  { "nome": "Athletico-PR", "externalId": 1768, "cartolaClubeId": 293 }
]
```

## 17–19. Compatibilidade com atletas

Flamengo × Corinthians: partida football-data 555005 da rodada 27, clubes Cartola 262 × 264.
Atlético-MG × Fluminense: partida football-data 555000 da rodada 27, clubes Cartola 282 × 266.
Athletico-PR: clube Cartola 293, visitante de Coritiba na partida 555004.

Os IDs são diretamente comparáveis ao clube_id no payload existente de CartolaService.getScoredAthletes().
A validação adicional usou o histórico real consolidado de 2026/25 pelo próprio service:
- 262 / Flamengo: 15 atletas
- 264 / Corinthians: 15 atletas
- 282 / Atlético-MG: 16 atletas
- 266 / Fluminense: 16 atletas
- 293 / Athletico-PR: 16 atletas

Esses números são do histórico 25, não previsão ou escalação dos jogos da rodada 27.
A coleção pode ser obtida por GET /cartola/atletas/pontuados/25?temporada=2026.
Para o fluxo corrente, permanecem disponíveis GET /cartola/atletas/pontuados e a versão por rodada.
O consumidor usa o cartolaClubeId recebido no jogo para filtrar clube_id; não precisa descobrir mapping.
Nenhuma alteração foi feita nesses endpoints/services.

## 20–22. Testes

33 testes adicionados:
20 associações individuais, completude/unicidade do mapa, desconhecido BSA, três competições não-BSA,
compatibilidade com CartolaService, três endpoints HTTP, resposta BSA com null,
resposta não-BSA com null mesmo para clube compartilhado, preservação de vínculo administrativo em sync
e persistência/consulta não-BSA real com rollback.
Testes existentes de sync/idempotência foram ampliados para verificar os vínculos.

Suíte completa executada com FUTEBOL_INTEGRATION_TEST=1:
614 aprovados em 38 suítes; 24 ignorados em 7 suítes; 638 descobertos.
Inclui testes de futebol, Cartola e teste real MySQL não-BSA.
O teste MySQL cria dados temporários dentro de transação e força rollback; confirmou ausência desses registros depois.
Sem a variável, apenas esse teste adicional de banco é ignorado.

## 23–24. Build e lint

npm.cmd run build aprovado.
Lint da entrega aprovado.
Lint global falhou apenas pelo erro preexistente _id sem uso em test/recarga-pix.integration.spec.ts:68; arquivo preservado.
git diff --check aprovado.

## 25–26. Sincronização real e contagens

npm run futebol:sync executado duas vezes com sucesso.
Cada execução: 20 clubes processados, 380 partidas recebidas, 380 persistidas.
Consulta posterior: 20 clubes, 380 partidas, zero duplicidade de EXTERNAL_ID em clubes/partidas,
todos os 20 cartolaClubeId iguais ao mapa verificado e nenhum null entre os clubes BSA atuais.

## 27–29. Confirmações de preservação

- Sem N+1: apenas acrescentado um campo ao select relacional existente dos clubes; não há lookup individual nem join de atletas.
- Endpoints de leitura não chamam football-data.org nem Cartola. O módulo de leitura continua dependente apenas do Prisma.
- Somente o comando manual futebol:sync acessou football-data na validação.
- Consultas administrativas aos recursos Cartola foram usadas para conferir os IDs, não para montar respostas de futebol.
- Nenhuma alteração foi feita no frontend, autenticação, carteira/PIX, parciais, substituições ou regras fantasy.
- Não foi implementada nova competição, automação, polling, scheduler ou frontend.
- Credenciais não foram impressas nem alteradas.

## 30. Pendências e riscos

- A associação não transforma IDs de partidas football-data em partida_id Cartola. A futura UI deverá usar os IDs de clube recebidos e escolher a rodada adequada no fluxo de atletas.
- Disponibilidade dos atletas continua dependente do mercado e dos snapshots/regras atuais do Cartola; um clube corretamente vinculado pode não ter atletas pontuados disponíveis para uma rodada.
- IDs conhecidos no mapa são canônicos e reaplicados no sync; correções administrativas desses IDs devem atualizar o mapa controlado também.
- Novos clubes BSA sem mapping permanecem null até associação explícita, sem inferência ou bloqueio da carga.
- Como não existe tabela própria de clubes Cartola, não há integridade referencial por FK; a segurança vem do mapa conferido e dos testes.
- O teste MySQL usa rollback, mas pode consumir valores de AUTO_INCREMENT; não deixa dados de outras competições.
- Permanece o erro preexistente de lint global.
- Fase 3 não iniciada.
