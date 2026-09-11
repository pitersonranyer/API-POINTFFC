# Futebol — Fase 2.1

## 1. Arquivos criados

- src/futebol/futebol-clubes.ts
- prisma/migrations/0014_futebol_nome_original/migration.sql
- docs/football-data-fase-2.1.md

## 2. Arquivos alterados nesta fase

- prisma/schema.prisma
- src/futebol/football-data.normalizer.ts
- src/futebol/futebol-query.service.ts
- src/futebol/dto/futebol-query.dto.ts
- test/futebol.spec.ts
- test/futebol-query.spec.ts

As alterações anteriores das Fases 1 e 2 no working tree foram preservadas.

## 3. Migration

0014_futebol_nome_original aplicada com sucesso no MySQL local.
Adiciona NOME_ORIGINAL, copia o NOME existente antes de qualquer alteração e torna a coluna obrigatória.
Atualiza NOME e NOME_CURTO dos 20 clubes por EXTERNAL_ID.
A migration 0013 não foi alterada. Nenhum índice novo.

## 4. Modelagem e sincronização

- nomeOriginal / NOME_ORIGINAL: nome bruto recebido do provedor, VARCHAR(255) obrigatório.
- nome / NOME: apresentação PointFFC.
- nomeCurto / NOME_CURTO: o mesmo nome amigável para os 20 clubes mapeados.
- sigla e escudoUrl: preservados do provedor.

mapTeam aplica o mapeamento por EXTERNAL_ID em cada sincronização, incluindo updates por upsert.
Uma mudança textual do nome institucional não altera o nome PointFFC.
Para IDs desconhecidos, nome usa o nome original e nomeCurto usa o shortName original, ou o nome original se shortName for null.
O caso desconhecido não interrompe a carga. Nenhum dos 20 clubes atuais precisou de fallback.
Os endpoints mantêm o contrato anterior, retornando nome e nomeCurto amigáveis, sem expor nomeOriginal como apresentação.

## 5. Mapeamento completo

IDs conferidos nos registros MySQL existentes, sem consulta externa para montar o mapa.

| externalId | Nome PointFFC |
| --- | --- |
| 1765 | Fluminense |
| 1766 | Atlético-MG |
| 1767 | Grêmio |
| 1768 | Athletico-PR |
| 1769 | Palmeiras |
| 1770 | Botafogo |
| 1771 | Cruzeiro |
| 1772 | Chapecoense |
| 1776 | São Paulo |
| 1777 | Bahia |
| 1779 | Corinthians |
| 1780 | Vasco |
| 1782 | Vitória |
| 1783 | Flamengo |
| 4241 | Coritiba |
| 4286 | Bragantino |
| 4287 | Remo |
| 4364 | Mirassol |
| 6684 | Internacional |
| 6685 | Santos |

## 6. Regra final de rodada atual

A regra da Fase 2 descrita no relatório anterior foi substituída por esta:

1. Consultar apenas a temporadaAtual da competição, com rodada não nula.
2. Capturar uma única vez o instante UTC atual.
3. Se houver IN_PLAY ou PAUSED, selecionar a rodada do jogo com menor dataHoraUtc; empatar por menor rodada e menor ID.
4. Caso contrário, selecionar o próximo SCHEDULED/TIMED com dataHoraUtc maior ou igual ao instante atual. Ordenar por dataHoraUtc, rodada e ID ascendentes.
5. Se não houver jogo em andamento nem agendamento futuro, selecionar a maior rodada com FINISHED ou AWARDED.
6. Se nenhuma rodada elegível existir, retornar HTTP 200 com rodada=null, total=0 e jogos=[].
7. Após selecionar, retornar todos os jogos da rodada, inclusive POSTPONED, SUSPENDED, FINISHED e CANCELLED.

Proximidade temporal significa o próximo compromisso futuro no calendário, em vez da menor rodada numérica.
SCHEDULED/TIMED com horário passado são ignorados na seleção para evitar que registros sem atualização prendam o calendário.
POSTPONED, SUSPENDED e CANCELLED não definem a rodada, mas continuam consultáveis.
A regra não exclui nem modifica partidas.
O relógio é fixado nos testes para tornar a escolha reprodutível.
As consultas e a ordenação são executadas no MySQL, sem varrer a temporada em memória.

## 7. Testes novos e adaptados

13 testes adicionados:
- Quatro nomes institucionais: Atlético-MG, Athletico-PR, Flamengo e Corinthians.
- Mapeamento independente do texto original.
- Dois casos de fallback para clube desconhecido.
- Segunda sincronização preservando nome amigável e atualizando nome original sem duplicidade.
- Prioridade de IN_PLAY sobre agendamento próximo.
- Proximidade futura prevalecendo sobre o número da rodada.
- POSTPONED permanece na rodada atual e na consulta específica antiga.
- Próxima rodada futura após rodada encerrada.
- Agendamento passado sem atualização não prende a seleção.

Seis casos antigos que testavam a regra substituída foram adaptados:
quatro status elegíveis com POSTPONED antigo e dois casos sem rodada elegível (apenas POSTPONED/SUSPENDED).
Os testes existentes de campeonato encerrado, resposta vazia e isolamento do FootballDataClient continuam passando.

## 8. Total de testes

581 testes executados e aprovados em 36 suítes.
24 testes ignorados em 7 suítes, pelas condições existentes.
605 testes descobertos. Nenhuma falha.

## 9. Build

npm.cmd run build aprovado, incluindo geração Prisma e compilação Nest.

## 10. Lint

Lint da entrega aprovado.
Lint global continua com o único erro preexistente: _id sem uso em test/recarga-pix.integration.spec.ts:68.
Arquivo preservado. git diff --check aprovado.

## 11. Nova sincronização

npm.cmd run futebol:sync executado com sucesso contra a football-data.org.
20 clubes processados, 380 partidas recebidas e 380 partidas persistidas.
Consulta posterior confirmou 20 clubes, 380 partidas, zero EXTERNAL_ID duplicados em ambas as tabelas.
Nomes originais preservados e nomes amigáveis confirmados nos 20 registros.
Credenciais não foram exibidas nem alteradas.

## 12. Rodada real identificada

Validação em 2026-09-11T13:02:06.194Z:
GET /futebol/competicoes/BSA/rodada-atual retornou HTTP 200, temporada 2026, rodada 27, total 10.
Validação HTTP executada com módulo de leitura e MySQL real, bloqueando fetch externo.

## 13. Jogos retornados

Todos estavam TIMED no momento da validação. Horários UTC.

| Mandante | Visitante | Data UTC |
| --- | --- | --- |
| Coritiba | Athletico-PR | 2026-09-12 00:00 |
| Atlético-MG | Fluminense | 2026-09-12 19:00 |
| Grêmio | Vasco | 2026-09-12 19:00 |
| Chapecoense | Internacional | 2026-09-12 20:00 |
| Palmeiras | São Paulo | 2026-09-12 21:30 |
| Botafogo | Bragantino | 2026-09-12 23:30 |
| Santos | Cruzeiro | 2026-09-13 00:00 |
| Mirassol | Vitória | 2026-09-13 19:00 |
| Flamengo | Corinthians | 2026-09-13 20:30 |
| Bahia | Remo | 2026-09-14 23:00 |

CA Mineiro não aparece como nome de apresentação: nome=Atlético-MG e nomeCurto=Atlético-MG.
O texto institucional permanece somente em nomeOriginal no banco.

## 14. POSTPONED antigo

As partidas externalId 554940, 554942 e 554948 continuam POSTPONED na rodada 21.
Mesmo assim, a API selecionou a rodada 27. Portanto, as adiadas antigas não prendem mais a rodada atual.

## 15. Isolamento externo

Os endpoints de leitura não chamam football-data.org.
Somente o comando manual de sincronização realizou acesso externo nesta validação.
O módulo de leitura não registra FootballDataClient; os testes HTTP continuam verificando que nenhum método desse client é chamado.

## 16. Pendências e riscos

- Os dados refletem a última sincronização manual. Um status IN_PLAY/PAUSED desatualizado ainda terá prioridade; não foi introduzida heurística de duração sem requisito.
- Entre jogos de uma rodada, a escolha acompanha o próximo compromisso agendado. Uma partida antiga reagendada como TIMED e próxima no calendário pode legitimamente definir sua rodada; apenas POSTPONED/SUSPENDED não a definem.
- O mapeamento deve ser ampliado por ID se clubes novos entrarem; até lá aplica-se o fallback preservando o original.
- Nenhuma credencial foi alterada ou rotacionada.
- Permanece o erro preexistente de lint global documentado.
- Frontend e demais funcionalidades fora do escopo não foram iniciados.
