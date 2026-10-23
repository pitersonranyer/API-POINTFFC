# Fase 4B — resultados persistidos na API

## Contratos antes e depois

Os dois GETs mantêm todos os campos anteriores, JWT obrigatório e usuário ativo.
Acrescentam `resultado` opcional. Ausência de resultado vigente não é zero: o campo
é omitido. O ranking existente mantém a ordenação e suas regras.

| GET | Antes | Depois |
| --- | --- | --- |
| `/point-fantasy/competicoes/:id/escalacoes/minhas` | Identidade, estado da identidade, legados, items com seleção e validação, total/page/limit | Mesmo envelope; cada item pode conter resumo `resultado` |
| `/point-fantasy/escalacoes/:id` | Seleção original, identidade, atletas congelados, versão, datas e validação | Mesmos campos; `resultado` com resumo e detalhe persistido |

Resumo: `pontuacao: string|null`, `estadoPontuacao: PARCIAL|INDISPONIVEL`,
`revisao: string`, `atualizadoEm: ISO-8601`, `posicao: number|null`.
Resultados antigos de outra revisão, hash, versão da escalação ou motor são omitidos.
Posições só aparecem quando todos os inscritos possuem total vigente, como no ranking.
Fechamento definitivo não converte PARCIAL em FINAL.

Detalhe acrescenta:

- `capitaoOriginalAtletaId`, `capitaoEfetivoAtletaId`, `reservaMagoAtletaId`.
- `reservasUtilizados`, `titularesSubstituidos`: arrays de IDs do catálogo congelado.
- `contribuicoes`: 12 registros persistidos, incluindo técnico, com
  `titularOriginalAtletaId`, `catalogoAtletaId`, `pontuacaoContabilizada`, `multiplicador`.
- `atletas`: todos os selecionados, com `catalogoAtletaId`, `papelOriginal`,
  `pontuacaoOficial`, `pontuacaoContabilizada`, `multiplicador`, `titularEfetivo`,
  `capitaoOriginal`, `capitaoEfetivo`, `reservaMagoDesignado`, `reservaUtilizado`,
  `utilizadoComoMago`, `entrouEmCampo` e `origemParticipacao`.
- `substituicoes`: `titularSaiuId`, `reservaEntrouId`, `regra: COMUM|MAGO`,
  `pontuacaoOficial`, `pontuacaoContabilizada`, `multiplicador`, `herdouCapitao`.

O frontend relaciona nomes/posição/imagens pelos IDs e pelo array `atletas` original.
Usa `contribuicoes` para o campinho efetivo e `substituicoes` para as trocas.
Não deve multiplicar nem somar novamente os valores contabilizados.
Em atletas sem contribuição, o valor contabilizado é `"0"` e o multiplicador neutro `1`;
o capitão original substituído continua marcado, mas o 2x está no capitão efetivo.
Pontos oficiais ausentes permanecem `null`, inclusive em ausências comprovadas.
Participação desconhecida permanece `null`. As origens possíveis são
`REGISTRO_OFICIAL`, `NAO_PARTICIPACAO_INFERIDA_CARTOLA`, `INFORMACAO_AUSENTE`
e `IDENTIDADE_INCOMPATIVEL`.

## Exemplos reais R31

Recorte de Meus times (campos anteriores omitidos apenas neste exemplo):

```json
{
  "items": [
    {"id":7,"resultado":{"pontuacao":"85.51","estadoPontuacao":"PARCIAL","revisao":"2","atualizadoEm":"2026-10-23T17:21:54.053Z","posicao":1}},
    {"id":6,"resultado":{"pontuacao":"30.31","estadoPontuacao":"PARCIAL","revisao":"2","atualizadoEm":"2026-10-23T17:21:54.073Z","posicao":3}},
    {"id":5,"resultado":{"pontuacao":"34.41","estadoPontuacao":"PARCIAL","revisao":"2","atualizadoEm":"2026-10-23T17:21:54.068Z","posicao":2}}
  ],
  "total":3,"page":1,"limit":50
}
```

Escalação 5: recorte de `resultado` (arrays completos no JSON de evidência):

```json
{
  "pontuacao":"34.41","estadoPontuacao":"PARCIAL","revisao":"2",
  "atualizadoEm":"2026-10-23T17:21:54.068Z","posicao":2,
  "capitaoOriginalAtletaId":494,"capitaoEfetivoAtletaId":172,
  "reservaMagoAtletaId":502,
  "reservasUtilizados":[172,704,502],"titularesSubstituidos":[494,246,147],
  "substituicoes":[
    {"titularSaiuId":494,"reservaEntrouId":172,"regra":"COMUM","pontuacaoOficial":"-0.2","pontuacaoContabilizada":"0","multiplicador":2,"herdouCapitao":true},
    {"titularSaiuId":246,"reservaEntrouId":704,"regra":"COMUM","pontuacaoOficial":"3.2","pontuacaoContabilizada":"3.2","multiplicador":1,"herdouCapitao":false},
    {"titularSaiuId":147,"reservaEntrouId":502,"regra":"COMUM","pontuacaoOficial":"2.6","pontuacaoContabilizada":"2.6","multiplicador":1,"herdouCapitao":false}
  ]
}
```

494 Esquivel → 172 Gilberto; 246 Bernard → 704 Medina; 147 Arthur Cabral →
502 Leozinho. Leozinho é Mago designado, utilizado como COMUM.
Na escalação 6, Cuello contribui com `"1"`; na 7, Luiz Gustavo com `"5"`.
Medina e Breno Lopes entram na 7. Nenhuma troca MAGO nas três escalações.

Respostas completas obtidas dos serviços locais estão no artefato local
`point-fantasy-results-4b-examples.json`, preservado fora da publicação.

## Visibilidade e leitura

Antes do fechamento, somente o dono consulta detalhes. Depois do fechamento já
ocorrido, outro usuário autenticado e ativo consulta apenas INSCRITA de competição
PUBLICADA. Rascunhos alheios continuam 404. Escritas mantêm a verificação original
de proprietário. Ranking anterior ao fechamento mostra formação apenas ao dono;
para adversários e anônimos, retorna `formacao: null`. Cabeçalhos dos dois GETs:
`Cache-Control: private, no-store`.

A projeção usa campos permitidos, sem auditoria administrativa, hash, evidências
brutas, dados financeiros ou IDs pessoais. Não executa o motor nem reconstitui
substituições. Usa totais/contribuições/trocas persistidos e pontos oficiais Fantasy,
com identidade congelada e verificação compartilhada de revisão/hash/versão.
Resumo faz duas consultas em lote, independente do tamanho da página, sem ler
auditorias nem pontos individuais. Detalhe lê uma auditoria e os pontos em lote.

## Arquivos desta implementação

- `src/point-fantasy/lineups/lineup.service.ts`: amplia apenas leitura e visibilidade.
- `src/point-fantasy/lineups/lineup.controller.ts`: cache privado sem armazenamento.
- `src/point-fantasy/lineups/lineup-result.dto.ts`: tipos da projeção.
- `src/point-fantasy/lineups/lineup-result.read.ts`: resumo em lote e detalhe persistido.
- `src/point-fantasy/scoring/result-readiness.ts`: validação já usada pelo ranking, extraída.
- `src/point-fantasy/point-fantasy.service.ts`: reutiliza validação; formação privada antes do fechamento.
- `test/point-fantasy-lineup-result.spec.ts`: casos de resultado, privacidade e consultas.
- `test/point-fantasy-lineup.controller.spec.ts`: cabeçalhos HTTP.
- `test/point-fantasy-ranking.spec.ts`: visibilidade da formação.
- `test/point-fantasy-registration.spec.ts` e `test/point-fantasy-team-identity.spec.ts`:
  mocks de apuração ausente para contratos anteriores.
- `scripts/point-fantasy-results-4b-readonly.cjs`: validação local somente leitura.
- Este relatório e JSON de exemplos. Alterações anteriores permanecem preservadas.

## Validação e integração

162 testes em sete suítes de memória/HTTP passaram. Typecheck e build passaram.
O lint geral encontrou um erro anterior à 4B: import `normalizeOfficial` sem uso
em `src/point-fantasy/observation/current-scoring.service.ts:5`. Esse arquivo foi
preservado; o lint dos arquivos alterados nesta fase passou separadamente.
A validação local leu os serviços diretamente, sem bootstrap da aplicação,
migrations ou schedulers, e confirmou ranking estável em duas leituras e os totais
7=`85.51`, 5=`34.41`, 6=`30.31`. Fingerprints anteriores/posteriores de competições,
escalações e seus atletas, resultados, fechamento, apuração e pontos foram idênticos.
Não foram executados testes de integração que criam schemas ou gravam no MySQL.

A API está pronta para integração visual. O frontend precisa consumir os campos,
formatar decimais e tratar `resultado` ausente/pontos oficiais nulos. Não há alteração
de frontend nesta fase. A aplicação em execução precisa carregar a nova versão do
backend para servir esses contratos; nenhum deploy foi realizado.
