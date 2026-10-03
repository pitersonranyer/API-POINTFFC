# Cartelas de Desafios

Cada `DesafioInscricao` e uma cartela. `RASCUNHO` permite preencher palpites sem pagar nem ocupar vaga. `ATIVA` e a participacao efetivada. `CANCELADA` nao pode ser reativada ou receber palpites.

## Fluxo do frontend

1. `POST /desafios/:id/inscricoes`, com JWT e `{ "chaveIdempotencia": "uuid-da-tentativa" }`, cria um rascunho. Retorna `id`, `numero`, `nome` (`Palpite N`), `status`, `desafioId`, `valorInscricao` e `dataInscricao`. Reutilizar a mesma chave em retries; gerar outra chave somente para uma cartela nova. A resposta e HTTP 201, inclusive no replay.
2. `PUT /desafios/:id/partidas/:partidaId/palpite`, com `{ "inscricaoId": 123, "palpite": "CASA" }`, preenche/altera exclusivamente essa cartela. Aceita CASA/EMPATE/FORA e preserva o fechamento por partida.
3. `POST /desafios/:id/participar`, com `{ "inscricaoId": 123 }`, efetiva essa cartela. Exige todos os palpites obrigatorios, prazo e vagas disponiveis. FREE nao cobra; PAGO debita o valor atual do Desafio uma vez por inscricao. Repetir a confirmacao da mesma cartela retorna o snapshot original, sem nova cobranca.

Omitir `inscricaoId` nos endpoints legados usa sempre `Palpite 1`, criando seu rascunho no primeiro palpite se necessario. Nunca seleciona a ultima cartela implicitamente. Para multiplas cartelas, o frontend deve enviar o ID explicitamente.

## Detalhe e ranking

`GET /desafios/:id` inclui publicamente `limiteInscricoesPorUsuario` (default 1). Com JWT, inclui:

- `minhasInscricoes`: cartelas do proprio usuario, ordenadas por numero persistido, incluindo rascunhos e canceladas. Cada item tem os campos da inscricao e `palpites`, com `partidaId`, `meuPalpite`, `pontos`, `apurado` e `podeAlterarPalpite` para cada partida.
- `quantidadeUtilizada`: numero de cartelas ATIVAS. Rascunhos e canceladas nao consomem o limite por usuario.
- `inscrito`: true se qualquer cartela esta ATIVA.

Os campos legados `minhaInscricao` e `partidas[].meuPalpite/pontos/apurado` continuam representando somente `Palpite 1`. `minhaInscricao` e null enquanto essa cartela e rascunho. `dataInscricao` do rascunho indica criacao; na efetivacao passa ao instante de confirmacao.

O ranking soma por `inscricaoId`; cada item inclui `inscricaoId`, `numero`, `nome`, `participante`, `pontos`, `acertos` e `posicao`. Empates compartilham posicao conforme a regra existente. Apenas ATIVAS entram no ranking. A apuracao existente continua atribuindo 1/0 por palpite e retirando pontos de partidas anuladas.

O Admin configura `limiteInscricoesPorUsuario` nos endpoints existentes de criacao/edicao, com as mesmas restricoes de edicao de Desafios. O valor e inteiro entre 1 e 4294967295; null e invalido. `limiteParticipantes` continua contando inscricoes ATIVAS no Desafio.

## Concorrencia e migration

Criacao, gravacao de palpites e confirmacao usam o lock de DESAFIO existente. Sequencia e alocada sob esse lock; UNIQUEs por usuario/desafio/sequencia e por chave de criacao reforcam o isolamento. Confirmacao usa a ordem de locks DESAFIO -> USUARIO -> CARTEIRA, valida limites dentro da transacao e efetiva junto do debito. A referencia financeira identifica a inscricao.

Aplicar `0020_desafio_multiplas_inscricoes` com os escritores de Desafios suspensos e o backend antigo parado: DDL MySQL faz commit implicito e o backend antigo usa UNIQUEs substituidas. O backfill preserva os IDs, status, snapshots financeiros, palpites e pontos atuais. Todas as inscricoes atuais ficam com sequencia 1. Palpites sem inscricao recebem uma cartela RASCUNHO com valor zero, sem cobranca. A FK composta exige correspondencia de inscricao/desafio/usuario.

O teste de migration em MySQL real exige `DESAFIO_MIGRATION_TEST_DATABASE_URL`, apontando para banco descartavel vazio cujo nome contenha `test`. Ele nunca usa `DATABASE_URL` e deixa seus dados para inspecao. Sem essa variavel, os testes de contrato/schema/backfill SQL executam e a integracao real e ignorada.
