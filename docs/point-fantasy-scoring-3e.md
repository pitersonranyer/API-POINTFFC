# Fase 3E — ausências, fechamento e prévia R31

## Entrega e limites da execução

Implementados o tratamento genérico de ausência condicionada à fonte completa,
a prévia antes do fechamento e o fechamento administrativo auditável. O motor
de substituições da Fase 3C foi reaproveitado sem alteração de suas regras.
Nenhum fechamento, migration ou resultado foi executado/persistido no MySQL.
Nenhuma pontuação oficial, inscrição, escalação, outra competição, rodada 32
ou dado financeiro foi alterado. Não houve coleta, produção, frontend ou Git write.

## Ausências e procedência

`scoring/source-completeness.ts` verifica a última coleta aplicada da apuração,
temporada/rodada, revisão, hash corrente, hash do payload, estado de sucesso e
modelo atual. Recalcula o hash do conjunto com o mesmo algoritmo da coleta,
confere a quantidade de registros presentes e a identidade de todas as linhas.
Não depende de nomes ou de uma lista fixa de IDs.

Para permitir zero inferido, também exige certificado de fonte completa emitido
pelo verificador confiável existente e evidência de conclusão de **todas** as
partidas da rodada, vinculada à mesma temporada, rodada e hash do payload.
Confere IDs únicos de partidas/clubes, número esperado de confrontos, indicação
explícita de encerramento e pertencimento de cada confronto da competição.
Mercado aberto/fechado, rodada seguinte, passagem do tempo, HTTP 200 e confirmação
do operador não são provas de conclusão/completude.

O certificado existente ganhou o campo opcional `roundCompletion`. Quando um
verificador efetivamente o emitir, o escritor existente preservará essa evidência
em `limitacoes.evidenciaFonte.encerramentoRodada`. Nada foi emitido ou preenchido
artificialmente nesta fase. A política operacional parcial permanece parcial.
O verificador padrão continua sem fornecer certificados: esta entrega prepara
o consumo/persistência da prova, não cria uma autoridade de conclusão automática.

Contrato da extensão de evidência, recebido exclusivamente do verificador:

```typescript
roundCompletion?: {
  temporada: number;
  rodada: number;
  hashPayload: string;
  todasPartidasEncerradas: boolean;
  qtdPartidasEsperadas: number;
  partidas: {
    partidaIdExterno: number;
    clubeMandanteId: number;
    clubeVisitanteId: number;
    encerrada: boolean;
  }[];
};
```

Só com essa prova aprovada, atleta do catálogo ausente da lista oficial recebe
zero derivado e participação false **na entrada do motor**, sem INSERT/UPDATE
em `FANTASY_PONTUACAO_ATLETA`. Também considera linhas antigas preservadas com
`presenteNaUltimaLista=false`, sem substituir seu conteúdo original.

Auditoria dos resultados distingue `REGISTRO_OFICIAL`,
`NAO_PARTICIPACAO_INFERIDA_FONTE_COMPLETA`, `INFORMACAO_AUSENTE` e
`IDENTIDADE_INCOMPATIVEL`. Guarda catálogo, coleta, revisão e hash da evidência.
Zero oficial explícito mantém participação oficial e não vira ausência.
Registro presente com pontos desconhecidos ou identidade incompatível não é
convertido em zero. O resultado permanece pendente quando não é calculável.

O serviço utiliza versão `3E-1`, invalidando resultados de versões anteriores.
Idempotência inclui a evidência de ausência, com comparação JSON canônica para
não depender da ordem de chaves devolvida pelo MySQL.

## Fechamento administrativo

Novo endpoint sob os guards administrativos já existentes:

```text
POST /admin/point-fantasy/competicoes/:id/fechar
```

Body: `temporada`, `rodada`, `revisao` (string), `hashFonte`, `operacaoId` (UUID v4)
e `motivo`. Não recebe data de fechamento, identidade do administrador,
pontuações, certificados ou flags para pular validações.

Além do JWT e AdminGuard, o serviço verifica no banco se o administrador está
ativo. Exige competição publicada, catálogo congelado da mesma temporada/rodada,
janela de inscrição encerrada, confrontos existentes e a prova de conclusão e
completude descrita acima. Revisão/hash precisam coincidir com a solicitação.

Usa a transação Serializable existente, locks da competição e da apuração e
compare-and-set do registro da competição. Grava data gerada pelo servidor e
auditoria de operador, motivo, operação, revisão, hash, evidência e confrontos.
A mesma operação, com mesmo administrador e conteúdo, retorna o fechamento
original sem nova gravação. Tentativa conflitante é recusada. Falha de qualquer
escrita reverte fechamento e auditoria juntos. Não modifica inscrições ou atletas.

Uma única tabela auxiliar mínima, `FANTASY_FECHAMENTO_AUDITORIA`, foi preparada
na migration **0032_point_fantasy_closure_audit**, com PK/FK da competição e JSON
de auditoria. Isso evita depender de logs voláteis e não acrescenta coluna escalar
que quebraria consultas existentes antes da aplicação da migration.
0032 foi apenas escrita em arquivo e permanece pendente.

## Revisão da migration 0031

`0031_point_fantasy_lineup_results` permaneceu inalterada, hash SHA-256
`2a38f6a1856c12792106be5573dd465246277bfd7e2662d36f37f12fcb9dbdd7`.
Somente adiciona índice único em `FANTASY_ESCALACAO` e cria a tabela de
resultados com seus índices/FKs. Sem DROP, TRUNCATE, DELETE ou alteração de dados.
MySQL local 8.0.25, IDs e referências `int unsigned` compatíveis; o índice e as
duas tabelas novas ainda estão ausentes. Somente 0031 e a nova 0032 estão pendentes.

A revisão está pronta; aplicação real, FKs e concorrência real ainda precisam
de homologação autorizada. Nenhuma ferramenta de migração foi executada contra
o banco. Não foram criados bancos/schemas temporários.

## Evidência local R31 e prévia

Auditoria somente de leitura em 23/10/2026, MySQL exclusivamente local,
`fantasy_point_do_jogador`, competição 1, temporada 2026, rodada 31.
Apuração 1, revisão **2**, **306 registros**, última coleta aplicada **8**.
As três escalações continuam confirmadas e estruturalmente elegíveis.

Hash corrente:
`125a24de4479be5b5f37013a1370e2630465f40186d89686dab708b36bbef435`.

A coleta 8 está em sucesso operacional, mas `modalidade=PARCIAL`,
`evidenciaFonte=null` e contém `FINAL_COMPLETENESS_NOT_PROVEN` e
`COMPLETENESS_NOT_PROVEN`. A evidência das partidas contém HTTP/hash e premissa
de temporada, sem situação oficial de encerramento. Os confrontos 346526,
346530 e 346532 permanecem `AGENDADA` no registro da competição.

O conjunto corrente passou pela verificação de integridade/hash; isso **não**
comprova que o retorno externo estava completo ou que todos os jogos terminaram.
Impedimentos retornados pelo serviço:

- `COMPLETENESS_NOT_PROVEN`
- `OFFICIAL_ROUND_COMPLETION_NOT_PROVEN`
- `OFFICIAL_MATCH_EVIDENCE_INVALID`
- `COMPETITION_MATCH_SCOPE_UNPROVEN`

Os IDs informados pelo usuário foram conferidos no catálogo e estão ausentes
do conjunto oficial correto, sem atribuição de zero:

| Atleta | Cartola | Catálogo | Escalações afetadas |
|---|---|---|---|
| Arthur Cabral | 92171 | 147 | 5, 6 |
| Lyanco | 92087 | 241 | 5, 6 |
| Bernard | 72460 | 246 | 5, 6, 7 |
| Esquivel | 110668 | 494 | 5, 6 |
| Léo | 85626 | 498 | 5, 6 |
| Vitor Roque | 114802 | 656 | 7 |

| Escalação | Versão | Total prévio | Posição | Substituições |
|---|---|---|---|---|
| 5 — chute de ouro 01 | 3 | Pendente | — | Não calculáveis |
| 6 — chute de ouro 02 | 4 | Pendente | — | Não calculáveis |
| 7 — chute de ouro 03 | 2 | Pendente | — | Não calculáveis |

O método `preview` agora funciona antes do fechamento, validando todos os demais
invariantes sem modificar o registro e retornando o estado do fechamento.
`persist` continua exigindo fechamento efetivado. As listas vazias de
substituições nesta prévia representam falta de informação, não a previsão de
que não haverá trocas. A confirmação do usuário sobre os seis atletas foi
considerada, mas a regra adotada exige prova de fonte completa para inferência.

Evidência reproduzível: `node scripts/point-fantasy-3e-readonly.cjs`.
Saída detalhada: `docs/point-fantasy-3e-readonly.json`.

## Validação e pendências

Testes direcionados exclusivamente em mocks/memória cobrem ausência com fonte
completa, rodada em andamento, fonte parcial/incompleta, identidade/hash/escopo
divergentes, zero oficial, capitão ausente, reservas negativos, conflitos, empates,
idempotência, autorização administrativa, replay conflitante e rollback.
Resultado: **12 suítes, 237 testes aprovados**. Typecheck e build aprovados.

Para persistir o ranking, ainda faltam prova oficial verificável de conclusão
da rodada e completude da fonte, nova prévia calculável e autorização conjunta
para migrations 0031/0032, fechamento e persistência. Se a revisão mudar de 2,
será necessária autorização para a nova revisão. Nenhuma dessas operações foi
executada nesta fase.
