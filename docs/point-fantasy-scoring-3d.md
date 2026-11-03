# Fase 3D — homologação interrompida antes de gravar

Consulta: 23/10/2026, 11:28:50 (America/Sao_Paulo).

Branch `feat/point-fantasy-scoring-observation-3b2`. Alterações locais preservadas. Conexão exclusivamente com MySQL local, banco `fantasy_point_do_jogador`. Competição 1, temporada 2026, rodada 31, três escalações confirmadas e estruturalmente elegíveis, três partidas, revisão 2 e 306 registros oficiais.

## Resultado

- Fechamento definitivo: bloqueado; campo null. Não existe operação administrativa de fechamento em AdminPointFantasyController/PointFantasyService. As referências existentes apenas leem ou validam o campo. Não se criou funcionalidade nem se executou UPDATE direto.
- Migração 0031: não aplicada. SQL aditiva revisada: ADD UNIQUE INDEX em FANTASY_ESCALACAO e CREATE TABLE FANTASY_ESCALACAO_RESULTADO, com índices e FKs; nenhuma operação destrutiva. É a única migração pendente. Nenhum executor de migrations foi invocado, pois a sequência foi interrompida pelas pendências da prévia e ausência de fluxo de fechamento.
- Divergências históricas de checksum 0024/0025 correspondem exatamente aos pares já documentados em scripts/point-fantasy-local-migrations.cjs. Histórico não modificado.
- Resultados persistidos: **0**. A tabela de resultados continua ausente.
- Ranking, empates e soma persistida: indisponíveis; os três totais são null por falta de informação.
- Substituições comuns/Mago: nenhuma aplicada ou persistida. A prévia incompleta não permite afirmar quais serão realizadas.

## Prévia somente de leitura

Motor puro executado em memória com os dados reais e as mesmas validações de seleção/identidade da Fase 3C. Nenhuma alteração no fechamento ou chamada de persistência. O método preview do serviço exige fechamento; essa validação não foi contornada para escrever.

| Posição | Escalação | Pontos | Substituições | Capitão: pontos oficiais e 2x original |
|---|---|---|---|---|
| — | 5 — #G2FKLZJ · chute de ouro 01 | Indisponível | Não calculáveis | Esquivel: sem informação |
| — | 6 — #G2FKLZJ · chute de ouro 02 | Indisponível | Não calculáveis | Cuello: 0.5 × 2 = 1 |
| — | 7 — #G2FKLZJ · chute de ouro 03 | Indisponível | Não calculáveis | Luiz Gustavo: 2.5 × 2 = 5 |

Contribuições originais de capitão, antes de qualquer eventual substituição; não são resultados finais homologados.

## Pendências oficiais

Atletas sem registro de pontuação e sem evidência de não participação na temporada/rodada/apuração corretas. Não foram convertidos em zero.

| Atleta | ID catálogo | ID Cartola | Escalações | Papel |
|---|---|---|---|---|
| Arthur Cabral | 147 | 92171 | 5, 6 | TITULAR |
| Lyanco | 241 | 92087 | 5, 6 | RESERVA |
| Bernard | 246 | 72460 | 5, 6, 7 | TITULAR |
| Esquivel | 494 | 110668 | 5, 6 | TITULAR |
| Léo | 498 | 85626 | 5, 6 | TITULAR |
| Vitor Roque | 656 | 114802 | 7 | TITULAR |

## Pontuações individuais

Cada tabela contém 11 titulares, técnico e cinco reservas. A contribuição original é anterior às substituições; não foi somada a um total fictício. “Sem informação” não significa zero.

### Escalação 5 — #G2FKLZJ · chute de ouro 01

Formação 4-3-3; versão 3; total final indisponível.

| Papel | Atleta | ID catálogo / Cartola | Pontos oficiais | Multiplicador original | Contribuição original |
|---|---|---|---|---|---|
| TITULAR | Mycael | 493 / 110698 | -2 | 1x | -2 |
| TITULAR / CAPITÃO | Esquivel | 494 / 110668 | Sem informação | 2x | Indisponível |
| TITULAR | Claudinho | 738 / 147192 | 0 | 1x | 0 |
| TITULAR | Ferraresi | 449 / 105300 | 13.5 | 1x | 13.5 |
| TITULAR | Léo | 498 / 85626 | Sem informação | 1x | Indisponível |
| TITULAR | Danilo | 200 / 107231 | 2.7 | 1x | 2.7 |
| TITULAR | Bernard | 246 / 72460 | Sem informação | 1x | Indisponível |
| TITULAR | Luiz Gustavo | 626 / 71536 | 2.5 | 1x | 2.5 |
| TITULAR | Arthur Cabral | 147 / 92171 | Sem informação | 1x | Indisponível |
| TITULAR | Cuello | 243 / 98909 | 0.5 | 1x | 0.5 |
| TITULAR | Viveros | 510 / 143193 | 2.4 | 1x | 2.4 |
| TECNICO | Eduardo Domínguez | 707 / 92747 | 9.01 | 1x | 9.01 |
| RESERVA | Gabriel Delfim | 256 / 115674 | 8.9 | — | — |
| RESERVA | Gilberto | 172 / 80313 | -0.2 | — | — |
| RESERVA | Lyanco | 241 / 92087 | Sem informação | — | — |
| RESERVA | Medina | 704 / 109987 | 3.2 | — | — |
| RESERVA / MAGO | Leozinho | 502 / 123101 | 2.6 | — | — |

### Escalação 6 — #G2FKLZJ · chute de ouro 02

Formação 4-3-3; versão 4; total final indisponível.

| Papel | Atleta | ID catálogo / Cartola | Pontos oficiais | Multiplicador original | Contribuição original |
|---|---|---|---|---|---|
| TITULAR | Mycael | 493 / 110698 | -2 | 1x | -2 |
| TITULAR | Esquivel | 494 / 110668 | Sem informação | 1x | Indisponível |
| TITULAR | Claudinho | 738 / 147192 | 0 | 1x | 0 |
| TITULAR | Ferraresi | 449 / 105300 | 13.5 | 1x | 13.5 |
| TITULAR | Léo | 498 / 85626 | Sem informação | 1x | Indisponível |
| TITULAR | Danilo | 200 / 107231 | 2.7 | 1x | 2.7 |
| TITULAR | Bernard | 246 / 72460 | Sem informação | 1x | Indisponível |
| TITULAR | Andreas Pereira | 573 / 89274 | -2.1 | 1x | -2.1 |
| TITULAR | Arthur Cabral | 147 / 92171 | Sem informação | 1x | Indisponível |
| TITULAR / CAPITÃO | Cuello | 243 / 98909 | 0.5 | 2x | 1 |
| TITULAR | Viveros | 510 / 143193 | 2.4 | 1x | 2.4 |
| TECNICO | Eduardo Domínguez | 707 / 92747 | 9.01 | 1x | 9.01 |
| RESERVA | Gabriel Delfim | 256 / 115674 | 8.9 | — | — |
| RESERVA | Gilberto | 172 / 80313 | -0.2 | — | — |
| RESERVA | Lyanco | 241 / 92087 | Sem informação | — | — |
| RESERVA | Medina | 704 / 109987 | 3.2 | — | — |
| RESERVA / MAGO | Leozinho | 502 / 123101 | 2.6 | — | — |

### Escalação 7 — #G2FKLZJ · chute de ouro 03

Formação 4-3-3; versão 2; total final indisponível.

| Papel | Atleta | ID catálogo / Cartola | Pontos oficiais | Multiplicador original | Contribuição original |
|---|---|---|---|---|---|
| TITULAR | Carlos Miguel | 394 / 104084 | 14.1 | 1x | 14.1 |
| TITULAR | Alex Telles | 188 / 72493 | 7.6 | 1x | 7.6 |
| TITULAR | Piquerez | 396 / 102130 | 14.5 | 1x | 14.5 |
| TITULAR | Alexander Barboza | 163 / 99274 | 9.2 | 1x | 9.2 |
| TITULAR | Bruno Fuchs | 407 / 104085 | 5.5 | 1x | 5.5 |
| TITULAR | Danilo | 200 / 107231 | 2.7 | 1x | 2.7 |
| TITULAR | Bernard | 246 / 72460 | Sem informação | 1x | Indisponível |
| TITULAR / CAPITÃO | Luiz Gustavo | 626 / 71536 | 2.5 | 2x | 5 |
| TITULAR | Flaco López | 403 / 113103 | 11 | 1x | 11 |
| TITULAR | Viveros | 510 / 143193 | 2.4 | 1x | 2.4 |
| TITULAR | Vitor Roque | 656 / 114802 | Sem informação | 1x | Indisponível |
| TECNICO | Eduardo Domínguez | 707 / 92747 | 9.01 | 1x | 9.01 |
| RESERVA | Mycael | 493 / 110698 | -2 | — | — |
| RESERVA | Bruno Pacheco | 615 / 90061 | 6.7 | — | — |
| RESERVA | Ferraresi | 449 / 105300 | 13.5 | — | — |
| RESERVA | Medina | 704 / 109987 | 3.2 | — | — |
| RESERVA / MAGO | Breno Lopes | 617 / 93988 | 1.3 | — | — |

## Regras e validação

Conferidos: reserva comum apenas para titular comprovadamente ausente da mesma posição, com contribuição mínima zero; Mago na mesma posição buscando o melhor resultado entre combinações válidas, inclusive valores negativos, sem reutilização e com herança de 2x do capitão. Não foi identificada divergência concreta que justificasse alterar regras. Motor e funcionalidades existentes não foram modificados.

Testes em memória/mocks: **3 suítes, 34 testes aprovados** (scoring-engine, lineup-scoring e result-ranking). Nenhum banco/schema temporário foi criado.

## Para retomar

1. Disponibilizar evidência oficial persistida suficiente para os seis atletas pendentes, sem fabricar pontos ou presumir não participação. Nova coleta não está autorizada nesta fase.
2. Disponibilizar fluxo administrativo de fechamento definitivo. Implementá-lo seria funcionalidade nova, fora deste pedido.
3. Revalidar identidade, elegibilidade e revisão. Se a revisão não for 2, solicitar nova autorização.
4. Com as pendências resolvidas, aplicar exclusivamente 0031, persistir uma vez e conferir totais, auditoria, duplicidade e ranking.

Nenhuma escrita no MySQL foi executada. Outras competições, rodada 32, inscrições e finanças não foram alteradas. Não houve coleta, produção/Render, frontend, commit, push, merge ou deploy.

Evidência detalhada: `docs/point-fantasy-3d-readonly.json`. Reprodução: `node scripts/point-fantasy-3d-readonly.cjs`.
