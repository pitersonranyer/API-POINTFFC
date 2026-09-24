# Contrato dos cards da liga

`GET /ligas/:slug/competicoes` acrescenta:

- `quantidadeInscritos`: quantidade de inscrições `ATIVA` e `FINALIZADA`, sem `CANCELADA`.
- `premiacaoEmDisputa`: string decimal em BRL com duas casas, ou `null` quando não há premiação monetária aplicável.

Para PAGO, a base bruta é a quantidade válida multiplicada pelo `valorInscricao` da competição. A função compartilhada `calcularBasePremiacao` desconta a taxa percentual sobre essa base, a taxa fixa por inscrição válida, ou zero na ausência de taxa. O arredondamento é HALF_UP em centavos. Zero inscrições resulta em `"0.00"`.

Para FREE, o valor é a soma dos prêmios monetários fixos configurados, multiplicados pela quantidade de posições em cada faixa. Sem valor fixo positivo, retorna `null`; percentuais sobre inscrições gratuitas não geram prêmio monetário.

O campo é derivado em cada consulta, sem coluna, migration ou gravação no banco. Taxas e contagens internas não são expostas. O frontend apenas formata o valor; não calcula receita nem premiação. A listagem é consultada sem cache, a cada 30 segundos quando visível e ao recuperar foco/visibilidade.

O Dashboard Financeiro reutiliza a mesma função de taxas e mantém sua própria base de arrecadação: a soma dos snapshots de valor das inscrições. Nenhuma regra, resposta ou movimentação financeira desse dashboard foi alterada.

Os cards com `INSCRICOES_ENCERRADAS` ou `EM_ANDAMENTO` mostram “Em andamento | Ver parciais”; `ENCERRADA` mostra “Encerrada | Ver resultado”. Essas ações usam `/competicoes?id=:id&aba=ranking`, abrindo a aba Ranking existente, sem alterar status ou criar endpoints de parciais.
