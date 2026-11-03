# Coleta ATUAL única no MySQL local

Automação e revisões excepcionais: [comandos e autorizações atuais](point-fantasy-automatic-and-exceptional.md).

Atualização: [implantação local e corte concluídos em 21/10/2026](point-fantasy-local-deployment.md).
As referências abaixo à preparação sem alterações descrevem a tarefa original do CLI.

Comando: `npm.cmd run fantasy:collect:local -- TEMPORADA RODADA UUID --authorization ARQUIVO`.
Reutiliza `CurrentScoringService`, `partial-v1`, fonte oficial, normalizador, admissão,
lease/fence, idempotência e persistência diferencial existentes. Não inicia AppModule,
jobs ou endpoints. Não aplica migrations, inicializa controle nem executa backfill.

## Pré-condições

- Destino exato em `DATABASE_URL`: `mysql://USUARIO:SENHA@127.0.0.1:3306/fantasy_point_do_jogador`,
  sem query string, socket alternativo ou fragmento. A conexão Prisma recebe essa URL
  explicitamente. `localhost`, outra porta/schema e hosts remotos são recusados.
- 0029 e 0030 concluídas, checksums exatos, nenhuma migration falha pendente,
  estrutura igual à homologada: tabelas, índices, FKs, CHECKs, triggers e procedures.
  Os arquivos locais de 0029/0030 também precisam manter os checksums homologados.
- Corte controlado já realizado; escopo em ATUAL, backfill concluído quando houver
  origem legada, sem avanço posterior do legado. Administração/backfill agora admitem
  o principal somente com capacidades locais específicas do procedimento de corte;
  este CLI de coleta não executa operações administrativas.
- Sem lease vivo de outra operação. Temporada/rodada devem corresponder ao contexto
  oficial atual; o CLI não assume que a rodada histórica 31 continua sendo a atual.
- `NODE_ENV` diferente de production e ausência dos indicadores RENDER,
  RENDER_SERVICE_ID e RENDER_EXTERNAL_HOSTNAME. Política parcial explicitamente aceita.
- Código compilado: `npm.cmd run build`.

## Autorizar e executar depois do corte

Defina `$temporada` e `$rodada` para o escopo autorizado. Gere um UUID para esta
operação e um arquivo exclusivo, por exemplo em PowerShell:

```powershell
$uuid = [guid]::NewGuid().ToString()
$autorizacao = Join-Path $env:TEMP "point-ffc-coleta-$uuid.json"
npm.cmd run fantasy:collect:local -- prepare $temporada $rodada $uuid --authorization $autorizacao
```

`prepare` faz somente leituras e cria um arquivo novo (`wx`), com `approved: false`,
operador vazio e validade de 30 minutos. Só funciona quando as pré-condições do banco
já estão satisfeitas. Nenhum arquivo de autorização foi criado no principal nesta tarefa.

Revise o arquivo. Após autorização explícita para essa coleta, preencha `operator` e `reason` (justificativa obrigatória)
e altere somente `approved` para `true`. Preserve identidade, schema, temporada,
rodada, UUID, geração, checksums e validade capturados. Então execute uma vez:

```powershell
npm.cmd run fantasy:collect:local -- $temporada $rodada $uuid --authorization $autorizacao
```

O arquivo não é uma chave de acesso ao banco nem substitui credenciais MySQL. Sua
aprovação é uma decisão do operador local. Não há uma variável de ambiente que
libere escrita. A capacidade em memória só é emitida após validar o servidor real
(`@@server_uuid`, `DATABASE()`, `@@port`), os checksums e a estrutura, modo ATUAL e
geração. Ela fica vinculada ao banco/escopo/operação, não pode ser fabricada passando
um objeto ao construtor e é revalidada na aquisição, finalização e recuperação.
Alteração de modo/geração, expiração ou perda das proteções impede a gravação.

O CLI só aceita o principal exato. Nos testes, a mesma emissão/validação de capacidade
é exercitada com identidades de schemas isolados; não há flag no CLI para liberar
outro destino. O uso anterior do serviço em schemas isolados continua disponível.

## Resultado e repetição

STDOUT JSON informa alvo, operador, política, temporada/rodada, UUID, coletaId,
estado, erroCodigo, atletas, inseridos, alterados, omitidos, revisões, resultadoAplicacao
e limitações. Coletas admitidas mantêm resultado/erros/evidências no histórico existente.
Recusas antes da admissão são emitidas em STDERR JSON, sem criar uma coleta falsa.
Falha/recusa e resultado ainda EM_ANDAMENTO produzem exit code 1; SUCESSO produz 0.

Repetir o mesmo UUID retorna o resultado original sem nova consulta HTTP. Uma coleta
nova, inclusive após falha HTTP terminal, exige novo UUID e nova autorização. Se a
autorização expirou, uma nova aprovação do mesmo UUID permite consultar seu resultado
existente, mantendo a idempotência. Concorrência entre UUIDs continua arbitrada pelo
controle persistente e lease/fence; um concorrente pode ser recusado antes do HTTP.

Verificação SQL somente leitura após a coleta (substitua os valores autorizados):

```sql
SELECT TEMPORADA, RODADA, ATLETA_ID_CARTOLA, POSICAO_ID, PONTUACAO,
       PONTUACAO_TOKEN_ORIGINAL, SCOUTS, REVISAO_ALTERACAO, COLETA_ALTERACAO_ID
FROM FANTASY_PONTUACAO_ATLETA
WHERE TEMPORADA = 2026 AND RODADA = 31
ORDER BY ATLETA_ID_CARTOLA;
```

## Limites mantidos

`partial-v1` não certifica frescor, completude nem resultado final. Cache suspeito,
regressões, perda de campos informados, omissão ampla e revisão validada continuam
protegidos pelas regras existentes. Pontos e scouts não são convertidos em Number
para persistência. A fotografia integral da estrutura é conservadora: qualquer drift
de schema bloqueia o comando; não existe opção para ignorá-lo.

Para coleta histórica, CurrentScoringService exige temporada/rodada explícitas no
payload, ou uma âncora oficial previamente aceita para confirmar conteúdo idêntico
sem alteração de pontos. O mercado atual e a URL não comprovam sozinhos a temporada
histórica. Sem prova suficiente, SEASON_IDENTITY_UNPROVEN permanece; mudanças sem
temporada explícita são recusadas mesmo com âncora antiga. Veja os detalhes no novo
procedimento de automação/revisões. Outra rodada/temporada declarada continua rejeitada
pelo normalizador.
O corpo histórico da coleta real 5 não foi preservado, apenas seu hash/evidências de
contexto. Não é possível afirmar que aquela resposta contém temporada explícita sem
uma nova resposta autorizada. Nenhuma nova coleta foi executada nesta correção.

A aplicação das migrations e o corte não foram executados no principal. Este CLI
permanece condicionado a essas operações previamente autorizadas. Não houve HTTP
real, nova migration/tabela, scheduler, endpoint, commit, push, merge ou deploy.

Validação desta tarefa: 54 testes em quatro suítes (autorização/CLI, integração
MySQL, regras diferenciais e transporte HTTP simulado), mais 16 testes de admissão
entre processos. Todos aprovados; Prisma validate, typecheck e build aprovados.
As integrações usaram schemas isolados restaurados do backup verificado, nunca o
principal. Evidências finais: `C:/Users/piter/AppData/Local/Temp/point-ffc-local-current-4J9mE4`
e, para admissão, `C:/Users/piter/AppData/Local/Temp/point-ffc-local-current-j99ZaD/admission.json`.
