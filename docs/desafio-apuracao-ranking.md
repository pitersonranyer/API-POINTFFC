# Desafio — Apuracao e ranking (Etapa 6)

## Rotas

- `POST /admin/desafios/:id/apurar`: JWT e PLATFORM_ADMIN ativo; body ausente ou `{}`; HTTP 201, conforme acoes administrativas existentes.
- `GET /desafios/:id/ranking?pagina=1&limite=20`: publico; HTTP 200; limite maximo 100.

IDs sao internos, inteiros positivos de ate 4294967295. Body com resultados, pontos ou outros
campos e rejeitado com 400. Apuracao nao aceita resultados manuais.

## Fonte e tempo regulamentar

Reutiliza exclusivamente FootballDataClient, autenticacao/configuracao, timeout, rate limit e lotes
de IDs de football-data.org v4. `buscarResultadosPorIds` usa os mesmos `/matches/:id` e `/matches?ids=...`.
As consultas administrativas das etapas anteriores mantem seu contrato.

Documentacao oficial consultada:
- [Scores, duracao e placar de 90 minutos](https://docs.football-data.org/general/v4/overtime.html).
- [Changelog v4: regularTime e chaves home/away](https://docs.football-data.org/general/v4/index.html).

Somente `FINISHED` permite apurar um placar:
- `duration=REGULAR`: usa `score.fullTime.home/away`. Se regularTime tambem vier preenchido, precisa ser valido e coincidir.
- `duration=EXTRA_TIME` ou `PENALTY_SHOOTOUT`: exige `score.regularTime.home/away`, que identifica os gols apos 90 minutos.
- Nao usa `score.winner`, gols de extraTime ou penalties. Nao subtrai parciais do fullTime.

Os 90 minutos incluem os acrescimos do tempo regulamentar. Gols devem ser inteiros nao negativos,
na faixa suportada pelo schema. Score ausente, incompleto, contraditorio ou duracao desconhecida
produz pendencia `PLACAR_90_MINUTOS_INDISPONIVEL`. Nao ha chute de placar nem fallback para resultado acumulado.

Limitacao: a integracao anterior descartava score ao consultar partidas de Desafio; o novo adaptador
o preserva somente para a apuracao. A API pode nao entregar regularTime utilizavel em determinado jogo.
Nesse caso, a apuracao aguarda dados seguros numa nova execucao, sem resultado/pontos.

## Status, anulacao e pontos

| football-data.org | Estado no Desafio |
| --- | --- |
| SCHEDULED, TIMED | AGENDADA |
| IN_PLAY, PAUSED, EXTRA_TIME, PENALTY_SHOOTOUT | EM_ANDAMENTO |
| FINISHED com placar regulamentar seguro | FINALIZADA |
| FINISHED sem placar seguro | EM_ANDAMENTO, pendencia explicita |
| CANCELLED, SUSPENDED, POSTPONED, AWARDED | ANULADA, sem placar esportivo homologado |
| desconhecido | EM_ANDAMENTO, pendencia STATUS_NAO_SUPORTADO |

O schema nao possui PENDENTE_APURACAO; EM_ANDAMENTO representa tambem resultado ainda nao determinavel.
Partidas ANULADA ficam resolvidas/excluidas **para o Desafio**: nao geram pontos, erros ou pontuacao maxima.
Adiados/suspensos sao anulados conforme a regra desta etapa. Uma nova apuracao reconsulta inclusive
anuladas e finalizadas; se o fornecedor reagendar ou corrigir, recalcula o estado e pode reabrir o Desafio.

Snapshot recebe horario oficial, status, gols e resultado (`CASA`, `EMPATE`, `FORA`).
FINALIZADA: cada palpite recebe pontos=1 para acerto ou 0 para erro, apurado=true.
ANULADA/pendente: pontos=null, apurado=false, inclusive removendo pontuacao anterior revogada.
Os palpites de usuarios sem inscricao tambem podem ser apurados, mas nunca entram no ranking.
O endpoint nao cria nem muda a escolha original dos palpites.

Pontos sao atribuidos, nunca incrementados. Reexecutar nao acumula; correcao oficial pode mudar quem acertou.

## Transacao e estados do Desafio

Recusa RASCUNHO, CANCELADO, nao publicado e Desafio sem partidas. Aceita ABERTO, EM_ANDAMENTO e ENCERRADO.
Consulta externa ocorre antes do lock. Sob `SELECT ... DESAFIO ... FOR UPDATE`, revalida o snapshot
completo para impedir sobrescrita por consulta anterior a uma alteracao concorrente (409 para nova tentativa).
Confere fixture, competicao e identidade dos adversarios; IDs ausentes/duplicados ou identidade divergente nao geram escrita parcial.
Todas as partidas, palpites e status do Desafio sao escritos numa unica transacao ReadCommitted.
Qualquer falha desfaz a operacao inteira; nenhuma carteira/inscricao e alterada.

- Todas FINALIZADA/ANULADA: ENCERRADO.
- Pendencias e inicio global atingido, partida iniciada/finalizada ou Desafio ja em andamento/encerrado: EM_ANDAMENTO.
- Apenas futuras antes do inicio: preserva ABERTO.
- `dataFim` vencida nunca forca encerramento com pendencias.

Resposta ilustrativa:

```json
{
  "desafioId": 7,
  "status": "EM_ANDAMENTO",
  "totalPartidas": 3,
  "partidasApuradas": 1,
  "partidasAnuladas": 1,
  "partidasPendentes": 1,
  "pendencias": [{"partidaId": 3, "motivo": "PLACAR_90_MINUTOS_INDISPONIVEL"}]
}
```

Futuras/em andamento normais contam como pendentes mas nao geram aviso de placar inseguro.
Falhas externas: 502 resposta/rede/IDs incompletos, 503 configuracao/acesso/rate limit/indisponibilidade,
504 timeout. Nao expoe token ou body bruto do fornecedor.

## Ranking

Ranking inclui exclusivamente DesafioInscricao ATIVA. Nao inclui canceladas ou palpites de nao inscritos.
Inclui inscritos com zero pontos. Soma somente pontos 0/1 de palpites apurado=true, vinculados a
partidas FINALIZADA com resultado/gols validos. Pendentes/anuladas nunca entram na soma.
Acertos equivale aos pontos nesta regra de uma unidade por acerto.

Ordena pontos DESC, usuarioId ASC para estabilidade. Posicao = 1 + quantidade de participantes
com mais pontos, portanto empates compartilham posicao: 1, 1, 3, 4, 4. Calcula posicoes antes de paginar.
Leitura RepeatableRead mantem inscricoes, partidas e pontos no mesmo snapshot da consulta.
Ranking e calculado em memoria apos agregacao Prisma dos pontos; nao cria tabela ou materializacao.

Ranking visivel para publicados ABERTO/EM_ANDAMENTO/ENCERRADO apos inicioInscricao, inclusive depois
de dataFim. Rascunhos, cancelados e nao disponibilizados retornam 404. As regras anteriores de
listagem/detalhe publico permanecem intactas; apenas o ranking continua acessivel ao final.

```json
{
  "desafioId": 7,
  "status": "ENCERRADO",
  "totalPartidasValidas": 8,
  "totalPartidasApuradas": 8,
  "totalPartidasAnuladas": 1,
  "pontuacaoMaxima": 8,
  "ranking": [
    {"posicao":1,"participante":{"idUsuario":1,"nome":"Ana","fotoUrl":null},"pontos":8,"acertos":8},
    {"posicao":1,"participante":{"idUsuario":2,"nome":"Bruno","fotoUrl":null},"pontos":8,"acertos":8}
  ],
  "paginacao":{"pagina":1,"limite":20,"total":2,"totalPaginas":1}
}
```

Identificacao publica restrita a idUsuario, nome e fotoUrl; sem email, documento, saldo ou movimento financeiro.
Pontuacao maxima considera todas as partidas nao anuladas, inclusive as ainda pendentes.

## Escopo e testes

Sem mudanca de Prisma/migration. Sem premiacao, carteira, cron, notificacoes ou frontend.
Testes usam fetch mockado para o fornecedor, persistencia/rollback simulados e guards reais nos testes HTTP.
Nao comprovam locks/isolamento em MySQL real. Nao fazem chamadas externas reais.
