# Especificacao para o frontend — atualizacao do ranking

## Objetivo

Implementar no frontend a atualizacao das pontuacoes da rodada anterior antes de carregar o ranking.

A atualizacao deve ocorrer uma vez para cada combinacao de temporada, rodada e conjunto de times cadastrados. Ela deve ser executada novamente quando um novo time entrar na lista.

## Endpoint de atualizacao

```http
POST /parciais/atualizar-rodada-anterior?temporada={temporada}
Authorization: Bearer {token}
```

O numero da rodada nao precisa ser enviado. O backend consulta o status do Cartola e utiliza:

```text
rodada anterior = rodada atual - 1
```

Exemplo de resposta:

```json
{
  "temporada": 2026,
  "rodada": 25,
  "timesCadastrados": 30,
  "atualizados": 28,
  "jaProcessados": 0,
  "semSnapshot": 1,
  "timeIdsSemSnapshot": [123456],
  "falhas": 1,
  "detalhesFalhas": [
    {
      "timeId": 654321,
      "motivo": "Snapshot inconsistente"
    }
  ]
}
```

Contrato TypeScript sugerido:

```ts
export interface AtualizacaoRodadaAnterior {
  temporada: number;
  rodada: number;
  timesCadastrados: number;
  atualizados: number;
  jaProcessados: number;
  semSnapshot: number;
  timeIdsSemSnapshot: number[];
  falhas: number;
  detalhesFalhas: Array<{
    timeId: number;
    motivo: string;
  }>;
}
```

## Endpoint do ranking

Depois da atualizacao, carregar o ranking com a temporada e a rodada retornadas pelo POST:

```http
GET /ranking-geral?temporada={temporada}&rodada={rodada}&limit=100
```

## Regras de execucao

1. Verificar a necessidade de atualizacao ao entrar na tela do ranking.
2. Nao chamar novamente o POST quando a mesma rodada ja tiver sido atualizada para o mesmo conjunto de times.
3. Executar a atualizacao quando:
   - nao existir registro local para a temporada e rodada;
   - a rodada anterior tiver mudado;
   - a lista de IDs dos times cadastrados tiver mudado;
   - a ultima requisicao tiver falhado completamente.
4. Usar a temporada atual obtida do estado ou dashboard da aplicacao. Nao fixar o valor `2026`.
5. Usar o cliente HTTP e o mecanismo JWT ja existentes no frontend.
6. Evitar requisicoes duplicadas provocadas por renderizacoes simultaneas ou pelo `StrictMode` do React.
7. Salvar o controle local somente depois que o POST responder com sucesso.
8. Se a atualizacao falhar, tentar carregar o ranking ja persistido e disponibilizar a acao `Tentar atualizar novamente`.
9. Se alguns times falharem, exibir o aviso e continuar carregando o ranking.
10. Se existirem times sem snapshot, informar que eles nao possuem escalacao registrada para a rodada anterior.

## Controle no localStorage

Usar uma chave por temporada e rodada:

```ts
const cacheKey = `pointffc:ranking-update:${temporada}:${rodadaAnterior}`;
```

Formato sugerido:

```ts
export interface AtualizacaoRankingCache {
  temporada: number;
  rodada: number;
  timeIds: number[];
  atualizadoEm: string;
}
```

Antes de comparar ou salvar, ordenar os IDs numericamente:

```ts
const timeIdsOrdenados = times
  .map((time) => time.timeId)
  .sort((a, b) => a - b);
```

A atualizacao sera necessaria quando o cache nao existir ou quando os IDs armazenados forem diferentes dos IDs atuais.

## Fluxo sugerido

```ts
async function carregarRanking() {
  const temporada = obterTemporadaAtual();
  const rodadaAtual = obterRodadaAtual();
  const rodadaAnterior = rodadaAtual - 1;
  const timeIds = obterTimesCadastrados()
    .map((time) => time.timeId)
    .sort((a, b) => a - b);

  let rodadaRanking = rodadaAnterior;

  if (precisaAtualizar(temporada, rodadaAnterior, timeIds)) {
    const resultado = await atualizarRodadaAnterior(temporada);
    rodadaRanking = resultado.rodada;

    salvarControleLocal({
      temporada: resultado.temporada,
      rodada: resultado.rodada,
      timeIds,
      atualizadoEm: new Date().toISOString(),
    });

    if (resultado.falhas > 0) {
      exibirAviso(`${resultado.falhas} time(s) nao puderam ser atualizados.`);
    }

    if (resultado.semSnapshot > 0) {
      exibirAviso(
        `${resultado.semSnapshot} time(s) nao possuem escalacao salva para a rodada.`,
      );
    }
  }

  return buscarRanking(temporada, rodadaRanking, 100);
}
```

## Estados da interface

Durante o POST, mostrar:

```text
Atualizando pontuacoes da rodada anterior...
```

Depois do processamento:

- mostrar o ranking normalmente quando a consulta funcionar;
- informar quantos times foram atualizados, se for relevante para a interface;
- mostrar um aviso nao bloqueante para falhas parciais;
- oferecer `Tentar atualizar novamente` se a requisicao falhar;
- nao deixar a tela carregando indefinidamente.

## Protecao contra chamadas simultaneas

Manter uma unica Promise em andamento para a atualizacao. Todas as renderizacoes devem reutilizar essa Promise enquanto a requisicao estiver ativa.

Exemplo conceitual:

```ts
let atualizacaoEmAndamento: Promise<AtualizacaoRodadaAnterior> | null = null;

function atualizarUmaVez(temporada: number) {
  if (!atualizacaoEmAndamento) {
    atualizacaoEmAndamento = atualizarRodadaAnterior(temporada)
      .finally(() => {
        atualizacaoEmAndamento = null;
      });
  }

  return atualizacaoEmAndamento;
}
```

## Criterios de aceite

- A primeira entrada no ranking dispara uma unica atualizacao.
- Renderizacoes repetidas nao geram varios POSTs simultaneos.
- Uma nova visita para a mesma rodada e os mesmos times nao dispara o POST novamente.
- A inclusao de um novo time dispara uma nova atualizacao.
- O ranking utiliza a rodada retornada pelo backend.
- Falhas parciais nao impedem a exibicao dos times atualizados.
- Erros completos permitem tentar novamente.
- O token JWT e enviado na requisicao de atualizacao.
- Nenhuma temporada fica fixa no codigo.

## Limitacoes importantes

O `localStorage` evita repeticoes somente no mesmo navegador. Ele nao garante uma unica execucao global entre dispositivos ou usuarios.

O backend utiliza persistencia idempotente: se o endpoint for chamado novamente, a pontuacao existente e atualizada, sem criar registros duplicados.

Um time novo so pode receber a pontuacao da rodada anterior quando existir um snapshot da escalacao para aquela rodada. Caso contrario, seu ID sera retornado em `timeIdsSemSnapshot`.

Para garantir uma unica execucao global, independentemente do navegador, sera necessario adicionar posteriormente um controle de processamento no backend.
