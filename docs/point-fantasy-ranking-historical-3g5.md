# Fase 3G.5 - Leitura historica do Ranking Fantasy

Base: ed9a7d542213a856fff54a9fa3a8fc09e0fb4e89, com alteracoes locais nao commitadas.
Nenhum dado historico, migration, frontend ou motor de calculo foi alterado.

## Regra

- A referencia e getMarketStatus() do CartolaService, com seu cache existente. Nao se usa MAX(rodada) do banco.
- Competicoes anteriores a temporada/rodada oficial usam resultados Fantasy persistidos.
- Reutilizam-se as verificacoes existentes de competencia, temporada, rodada, revisao, hash, versao da escalacao e motor (isCurrentResult).
- Rodada imediatamente anterior: PROVISORIO enquanto estiver na janela de processamento final; uma revisao explicitamente validada conserva DEFINITIVO.
- Rodadas anteriores a essa janela, ou temporadas anteriores: resultados completos e coerentes podem retornar DEFINITIVO mesmo com apuracao OBSERVANDO e RodadaProcessamento EM_ANDAMENTO.
- EM_REVISAO ou revisao validada divergente da atual: PENDENTE, sem declarar classificacao final.
- Dados incompletos: PENDENTE com motivoPendencia; preservam-se pontos compativeis disponiveis, inclusive zero, e as posicoes ficam nulas para nao classificar um conjunto incompleto.
- Referencia oficial stale: permite consulta historica provisoria com cacheDesatualizado=true, sem declarar DEFINITIVO.
- Falha/ausencia de referencia oficial: preserva o caminho anterior de consulta live/resultado validado, sem inferir a rodada atual do banco.
- O caminho atual/futuro e a leitura live permanecem com as mesmas regras de pontuacao. Nenhuma busca de pontos ou partidas nem replay do motor ocorre no caminho historico.

motivoPendencia: SEM_INSCRICOES, APURACAO_INDISPONIVEL, APURACAO_EM_REVISAO, REVISAO_EM_VALIDACAO,
RESULTADO_AUSENTE, RESULTADO_DESATUALIZADO ou PONTUACAO_INDISPONIVEL.
O campo e aditivo; o restante do contrato publico foi preservado.

## Homologacao real em 16/11/2026

Aplicacao Nest local minima com controller, servicos e Prisma reais, sem AppModule, migrations automaticas ou schedulers.
Conexao restrita a MySQL 127.0.0.1:3306/fantasy_point_do_jogador. Middleware Prisma permitiu apenas leituras.
Mercado oficial consultado: temporada 2026, rodada 35.

GET /point-fantasy/competicoes/1/ranking?page=1&limit=50
HTTP 200; Cache-Control: private, no-store; estadoPontuacao: DEFINITIVO; total: 3.

| Posicao | Escalacao | Pontuacao |
|---|---|---|
| 1 | 7 | 85.51 |
| 2 | 5 | 34.41 |
| 3 | 6 | 30.31 |

Nomes e identidade publica nao sao reproduzidos neste registro. A resposta completa manteve brasao,
nomePublico, identidade, formacao e meuTime conforme o contrato.

- Duas respostas sucessivas identicas.
- Paginacao com limit=1: pagina 1 retorna ID 7 / posicao 1; pagina 2 retorna ID 5 / posicao 2; pagina 4 vazia.
- Pagina zero, limite 101 e ID nao numerico: HTTP 400. Competicao inexistente: HTTP 404.
- Zero chamadas ao previewCartolaCompetition durante as consultas HTTP.
- Unica rota upstream chamada: /mercado/status; nenhuma consulta de pontuados ou partidas.
- Conferencia independente do motor em modo preview: totais, auditorias persistidas e somas coincidentes.
- RodadaProcessamento permaneceu EM_ANDAMENTO; periodos das partidas e revisao validada nula permaneceram intactos.

Fingerprint SHA-256 identico antes/depois em 11 conjuntos: competicoes, partidas, catalogos, atletas,
escalacoes com seus atletas, apuracoes, pontuacoes, coletas, snapshots, resultados e auditorias de fechamento:

64cfb31854b4c2d21f359df86211bc421dc3d980e0842b08ecf48788f9631b96

## Verificacao automatizada

8 suites / 124 testes passaram: historico, ranking live, controller/paginacao, resultados,
preview Cartola, motor, persistencia mockada e integridade de fontes.
Os testes de regressao sao somente memoria/mocks, incluindo rodadas atuais/futuras, troca de temporada,
janela anterior, empates entre paginas, zero, negativos, nulos, revisoes inconsistentes e falhas/stale da referencia.
Typecheck, ESLint focado e compilacao Nest aprovados.

Nao houve criacao de banco, migration, escrita historica, commit, push ou deploy.
As evidencias R34 locais preexistentes foram preservadas.
