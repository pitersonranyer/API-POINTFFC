# Dashboard Financeiro Admin — V1

`GET /admin/dashboard-financeiro` exige Bearer JWT e usuario `PLATFORM_ADMIN` `ATIVO`.

## Filtros e resposta

Filtros opcionais combinados por AND: `ligaId`, `competicaoId`, `rodada`.
IDs: inteiros de 1 a 4294967295. Rodada: inteiro de 1 a 255.
`pagina` inicia em 1 (padrao 1); `limite` de 1 a 100 (padrao 20).
Ordenacao estavel por ID da competicao crescente.

Rodada aplica `rodadaInicio <= rodada AND rodadaFim >= rodada`; intervalos nulos
nao correspondem. Valores sao da competicao inteira, sem rateio por rodada.
Nao ha filtro implicito por visibilidade, status da competicao ou liga ativa.
Combinacoes sem correspondencia retornam 200, lista vazia e totais zero.
Pagina alem do resultado retorna lista vazia, preservando totalizadores.

Totalizadores abrangem todo o conjunto filtrado. A listagem e os totais usam
a mesma transacao RepeatableRead. Inscricoes sao agrupadas no banco por
competicao e status; premiacoes sao consultadas separadamente, sem N+1 ou
join que multiplique valores. A V1 carrega as configuracoes de todas as
competicoes filtradas para calcular totais; o custo cresce com esse conjunto,
nao com a quantidade de inscricoes individuais.

## Regras

- Valores exclusivamente previstos/nominais. Nenhuma consulta a carteira ou PIX.
- Consideradas: ATIVA + FINALIZADA; CANCELADA aparece apenas na contagem separada.
- Valor das inscricoes: soma do snapshot `INSCRICAO_TIME_COMPETICAO.VALOR_INSCRICAO`.
- Taxa PERCENTUAL: valor das inscricoes vezes percentual / 100.
- Taxa VALOR_FIXO: valor configurado vezes quantidade considerada.
- Tipo e valor da taxa ambos nulos: taxa zero; configuracao incompleta: 409.
- Base: valor das inscricoes menos taxa. Sem limite artificial em zero.
- Premio VALOR_FIXO: valor por posicao vezes tamanho inclusivo da faixa.
- Premio PERCENTUAL: posicao unica, sobre base; soma percentual ate 100%.
- Premios fixos e percentuais podem coexistir; ambos entram na soma.
- A grade inteira e considerada, mesmo com menos inscritos que posicoes previstas.
- Saldo: base menos premiacao. Base, premios percentuais e saldo podem ser negativos.
- Decimal com precisao local 40, sem operacoes monetarias em Number.
- HALF_UP em centavos na taxa por competicao e em cada premio percentual.
  Base e saldo usam esses valores arredondados; totalizadores somam as linhas.
- Dinheiro e taxa configurada: string com duas casas. Percentual de premio:
  string com quatro casas, preservando a precisao do cadastro.
- Cadastros legados invalidos (incluindo faixa percentual) retornam 409 com
  identificacao da competicao, mesmo fora da pagina. Nao sao corrigidos automaticamente.

HTTP: 400 para query invalida; 401 para JWT ausente/invalido; 403 para perfil
ou status nao autorizado; 409 para configuracao financeira invalida.

## Exemplo ilustrativo (nao extraido de producao)

100 inscricoes ativas a R$ 100 no snapshot; taxa de 10%; primeiro premio de
40% da base; R$ 50 por posicao de 4 a 10.

```json
{
  "natureza": "PREVISTO_NOMINAL",
  "totalizadores": {
    "quantidadeCompeticoes": 1,
    "totalInscritos": 100,
    "inscricoesCanceladas": 0,
    "valorInscricoes": "10000.00",
    "receitaPointPrevista": "1000.00",
    "basePremiacao": "9000.00",
    "premiacaoCalculada": "3950.00",
    "saldoAposPremiacao": "5050.00"
  },
  "itens": [
    {
      "competicaoId": 7,
      "nome": "POINT FFC Rodada 27",
      "liga": { "id": 1, "nome": "POINT FFC" },
      "modalidade": { "id": 2, "nome": "Rodada", "codigo": "RODADA" },
      "rodadaInicio": 27,
      "rodadaFim": 27,
      "status": "INSCRICOES_ABERTAS",
      "tipoAcesso": "PAGO",
      "valorInscricao": "100.00",
      "inscritos": { "ativos": 100, "finalizados": 0, "cancelados": 0, "totalConsiderado": 100 },
      "taxaPlataforma": { "tipo": "PERCENTUAL", "valor": "10.00" },
      "financeiro": {
        "valorInscricoes": "10000.00",
        "receitaPointPrevista": "1000.00",
        "basePremiacao": "9000.00",
        "premiacaoCalculada": "3950.00",
        "saldoAposPremiacao": "5050.00"
      },
      "premiacoes": [
        { "posicaoInicio": 1, "posicaoFim": 1, "tipoPremiacao": "PERCENTUAL", "valor": null, "percentual": "40.0000", "ordem": 0, "valorCalculado": "3600.00" },
        { "posicaoInicio": 4, "posicaoFim": 10, "tipoPremiacao": "VALOR_FIXO", "valor": "50.00", "percentual": null, "ordem": 1, "valorCalculado": "350.00" }
      ]
    }
  ],
  "paginacao": { "pagina": 1, "limite": 20, "total": 1, "totalPaginas": 1 }
}
```

O endpoint nao cria inscricoes pagas nem persiste resultados calculados.
O fluxo existente de inscricao continua restrito a FREE; este exemplo explica
como a leitura trata snapshots pagos que existam no banco.
