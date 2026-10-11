# Histórico individual de atletas

`GET /cartola/atletas/:atletaId/historico?temporada=2026&rodadaReferencia=30&limite=5`

Endpoint público. `atletaId` é inteiro positivo seguro; `temporada` é obrigatória
entre 1 e 65535; referência opcional entre 1 e 38; limite 5 (padrão) ou 10.
Sem referência, seleciona a maior rodada CONSOLIDADA da temporada no banco.
Sem consolidada nesse caso, responde 404. Com referência explícita, mesmo uma
temporada sem registros retorna 200 com lacunas e indicadores nulos.

## Consulta e estados

O serviço depende apenas de PrismaService e consulta RodadaProcessamento.
Faz uma leitura em lote de 1 até a referência, além de uma leitura para resolver
a referência quando omitida. Não chama fontes externas, não grava e não preenche
histórico. Não introduz cache. A janela exibida é consecutiva, crescente e começa
no máximo na rodada 1. Média e cobertura usam o intervalo inteiro consultado.

`historico` contém rodada, statusRodada, situacao, motivo, pontuacao,
entrouEmCampo, scouts, consolidadoEm, estadoSnapshot e parcial. Os schemas completos
estão no Swagger em `/docs`.

- AUSENTE: sem registro; SEM_JSON: registro sem pontuados.
- INVALIDO: envelope malformado, rodada ou temporada explícita divergente.
- INCOMPLETO: sem atletas, envelope vazio ou total_atletas divergente.
- VALIDO: envelope estruturalmente aceito. A ausência de total_atletas não prova
  completude da fonte; não há certificação independente de todos os atletas.
- `parcial` indica registro não consolidado, mesmo se ainda não tiver JSON.

Atleta ausente permanece SEM_DADOS, com pontuação e participação nulas.
NAO_JOGOU exige entrou_em_campo=false e ausência de pontuação numérica oficial.
Zero, negativos e positivos oficiais finitos são preservados, inclusive quando
entrou_em_campo=false. Nesse caso a situação é PONTUADO e a evidência de participação
continua false. Não se infere participação usando clube, partidas ou escalações.

Pontuação inválida fica nula com DADO_INVALIDO. Scouts desconhecidos ficam nulos;
um objeto vazio explicitamente recebido é preservado. Scouts malformados ficam
nulos com motivo SCOUTS_INVALIDOS, sem descartar uma pontuação numérica válida.
Participação malformada fica nula com motivo PARTICIPACAO_INVALIDA.
Uma pontuação finita em envelope com total divergente pode ser exibida, mas é
excluída das estatísticas. Envelope de outra rodada/temporada não é projetado.

CONSOLIDADA é o estado global do processamento, não certificação independente
do atleta. Somente consolidadoEm disponível é retornado; atualizadoEm não é
interpretado como horário de coleta.

## Indicadores e cobertura

Estatísticas usam apenas pontuações finitas em envelopes VALIDO de rodadas
CONSOLIDADA, entre 1 e a referência. Não exigem participação explícita; representam
pontuações disponíveis, não média por jogos disputados.

- mediaGeralDisponivel = soma dos valores / amostraGeral; null com n=0.
- mediaUltimas5 usa rodadas max(1, referência-4) até referência e divide somente
  por amostraUltimas5; null com n=0, independentemente do limite de exibição.
- maior/menor retornam pontuação oficial e rodada; empate usa a primeira rodada.
- desvioPadrao = sqrt(soma((valor-média)^2)/n); null com n<2.
  Menor dispersão não significa melhor desempenho.

Decimal evita soma binária e overflow intermediário em variância. Médias e desvio
são arredondados a duas casas com ROUND_HALF_UP apenas na resposta. Histórico e
extremos preservam o valor oficial sem arredondamento adicional.

`cobertura` usa todas as rodadas de 1 até a referência:

- rodadasSemSnapshot: sem registro ou sem JSON.
- rodadasSemPontuacaoDoAtleta: sem pontuação numérica individual projetável.
- rodadasParciais: registros não consolidados.
- rodadasComSnapshotInvalidoOuIncompleto: problemas de envelope.
- temporadaComSnapshotsCompletosAteReferencia: todas têm envelope estruturalmente
  válido consolidado; nunca comprova cobertura de todas as participações do atleta.

Não há catálogo local completo para afirmar que um atleta sem histórico não existe.
Cobertura real do banco não foi consultada nesta implementação.
