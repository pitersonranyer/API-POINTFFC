# Referência coletiva de futebol

`GET /futebol/competicoes/:codigo/rodada-atual` lê apenas as partidas locais da
competição e temporada atual, em uma consulta. Não consulta o provider nem escreve
no banco. Não há migration, calendário persistido ou alteração do scheduler.

## Algoritmo

1. Agrupa por `fase + rodada`. A competição e a temporada são filtradas antes.
2. Usa a maior quantidade observada de partidas por rodada **na própria fase**
   como estimativa conservadora de cobertura. Não fixa quantidade de clubes,
   partidas ou rodadas para nenhuma liga.
3. Exige maioria estrita dessa quantidade, com mínimo de duas partidas.
4. Encontra o maior bloco de datas com amplitude inferior a sete dias. Empates
   escolhem a menor amplitude e depois a data mais antiga. O bloco precisa do
   quórum; partidas fora dele não alteram suas fronteiras. Status de adiamento,
   suspensão ou desconhecidos não removem datas do bloco. Um bloco precisa de
   quórum de partidas não canceladas.
5. Ordena rodadas numericamente **somente dentro da mesma fase**. A ordem entre
   fases é inferida pelo início do primeiro bloco coletivo de cada fase. Empates
   de fase usam o nome para determinismo, sem pretender inferir uma chave oficial.
6. Havendo ao menos um bloco coletivo, a referência inicial é a primeira etapa
   com quantidade suficiente. Rodadas com quantidade
   suficiente de partidas, mas datas fragmentadas, são preservadas como sucessoras:
   perder o bloco por uma remarcação não permite pular essa rodada. Um bloco que tenha quórum
   de partidas com horário alcançado estabelece progresso coletivo. Após seu fim,
   a referência avança ao próximo bloco conhecido. O fim ocorre quando todos os
   jogos do bloco estão FINISHED/AWARDED (e seus horários foram alcançados), ou às
   06:00 UTC do dia seguinte ao último dia UTC do bloco. Essa margem evita trocar
   a referência no instante do kickoff ou durante partidas no fim do dia.
7. No intervalo, a referência é o próximo bloco; ao fim da sequência conhecida,
   mantém o último. Um bloco posterior com progresso coletivo supera pendências
   de blocos anteriores. Uma partida isolada ao vivo não tem prioridade.
8. Conclusão é independente do fim do bloco: exige cobertura igual à estimada
   na fase e **todos** os jogos FINISHED/AWARDED, com horários alcançados. Um jogo
   atrasado não é declarado concluído porque seu bloco já passou. CANCELLED não
   confirma conclusão e não é listado como pendência jogável.

Com dados fixos, a progressão temporal percorre a sequência sem regressão e as
transições de calendário ocorrem no fechamento coletivo do dia, não no horário
individual de uma partida TIMED. A ordem de retorno das partidas é data e ID.

## Contrato

Além de `competicao` e `temporada`:

| Campo | Tipo | Semântica |
| --- | --- | --- |
| rodadaReferencia | number ou null | Número do bloco de referência. |
| faseReferencia | string ou null | Fase do bloco. |
| ultimaRodadaConcluida | number ou null | Última rodada integralmente resolvida, até a referência; anteriores podem ter pendências. |
| faseUltimaRodadaConcluida | string ou null | Fase dessa conclusão. |
| proximaRodada | number ou null | Sucessora da referência entre as etapas com quantidade suficiente de partidas. |
| faseProximaRodada | string ou null | Fase da sucessora. |
| partidasPendentes | jogo[] | Jogos não resolvidos de etapas anteriores; mantém fase, rodada, data e status originais. |
| jogos | jogo[] | Todos os jogos do grupo fase/rodada selecionado, inclusive fora do bloco de datas. |
| rodada | number ou null | Alias temporário de rodadaReferencia. |
| total | number | Quantidade de jogos, sem somar partidasPendentes. |

No intervalo, se a referência já é R28, `proximaRodada` é a sucessora R29, não R28.
Etapas coletivas com rodada nula são representadas por fase; podem ter jogos mesmo
com `rodadaReferencia: null`. Sem bloco elegível, jogos fica vazio e os campos de
referência são nulos. As pendências conhecidas continuam disponíveis.

## Limites deliberados desta primeira versão

É uma inferência dos dados persistidos, não uma reprodução garantida do calendário
oficial. Não garante estabilidade contra correções coletivas do provider nem
armazena referência anterior. A referência não é identificável com certeza quando
faltam dados ou não existe maioria concentrada em sete dias.

Grupos sem quantidade suficiente não estabelecem referência, conclusão ou próxima rodada.
Grupos com quantidade suficiente, mas sem bloco concentrado, não estabelecem
progresso por conta própria; podem ser a sucessora de um bloco que passou. A API
não inventa etapas ausentes. A maior cobertura observada não prova completude do
provider: se todas as rodadas forem importadas parcialmente, não há como detectar
todas as ausências só com esse modelo. Quantidades muito diferentes dentro da
mesma fase são tratadas conservadoramente.

Para CL, números repetidos entre fases nunca se misturam. Fases sem rodada com
vários jogos já funcionam. Uma final com um único jogo não estabelece bloco nesta
versão; transições de mata-mata ambíguas, fases simultâneas ou calendário muito
fragmentado exigirão metadados de formato em evolução futura. A política está
isolada do serviço e do DTO para permitir essa extensão.

## Exemplos sintéticos cobertos por testes

- R27 encerrada, R28 futura, um jogo R21 remarcado/ao vivo: referência R28,
  partida R21 em pendências.
- Um jogo R32 antecipado, inclusive FINISHED ou IN_PLAY, com o restante em outubro:
  não substitui R28.
- Passar um milissegundo do kickoff de um TIMED não muda a referência.
- Rodada parcialmente concluída permanece referência durante seu bloco; depois
  avança, preservando suas pendências e sem inventar conclusão.
- LEAGUE_STAGE/R8 seguida de LAST_16/R1: números comparados dentro de suas fases.

Os testes usam dados sintéticos. Nenhuma conclusão sobre a rodada correta de
produção foi obtida a partir do banco de desenvolvimento.
