# Backend Fantasy até a Fase 4B

Inclui apuração Cartola preservada, pontuação Fantasy, substituições COMUM/MAGO,
capitão efetivo 2x, persistência, ranking, fechamento administrativo com auditoria
e os dois contratos de leitura de escalações. Nenhum resultado local é carregado
em produção. A inicialização não depende da competição 1 ou de atletas específicos.

## Migrations automáticas

O bootstrap de produção chama `scripts/deploy-migrations.cjs` antes de iniciar Nest.
Nenhum coletor ou fechamento é invocado. Os arquivos das migrations permanecem
inalterados, inclusive os checksums homologados de 0030, 0031 e 0032.

1. Adquire lock exclusivo da inicialização e recusa histórico com migração falha.
2. Se 0030 estiver pendente, o Prisma aplica a cadeia original até 0029 usando
   uma cópia temporária dos arquivos anteriores, sem modificar o repositório.
3. Recusa corte automático caso as tabelas de apuração já contenham registros.
4. Registra o início de 0030 com checksum original. Envia seu SQL via Prisma,
   substituindo somente os separadores de linha do cliente MySQL (`DELIMITER`).
5. Verifica os 18 triggers e três procedures antes de marcar a nova entrada como
   concluída. Não altera registros de migrations anteriores.
6. Executa `prisma migrate deploy` na cadeia completa para aplicar 0031/0032.

DDL MySQL não é transacional. Uma falha deixa a entrada nova incompleta com aviso
de possível DDL parcial, impede o bootstrap e bloqueia repetição automática.
Inspecionar logs, histórico e schema antes de intervir. Não executar resolve/reset
ou repetir DDL sem diagnóstico. Migrations já concluídas não são reaplicadas.

0031 cria `FANTASY_ESCALACAO_RESULTADO` e o índice aditivo autorizado em
`FANTASY_ESCALACAO`. 0032 cria `FANTASY_FECHAMENTO_AUDITORIA`. Não há DML para
copiar dados de homologação nem lógica nova de coleta automática em produção.

## Homologação da adaptação

Fluxo real executado exclusivamente em schema MySQL local isolado
`point_fantasy_bootstrap_test_1792782015175`, preservado para inspeção:

- 32 migrations concluídas; checksum original de 0030 mantido.
- 18 triggers e três procedures verificados pela própria procedure homologada.
- Segunda execução idempotente, sem alteração do histórico.
- Nenhum resultado de escalação inserido; dados locais da competição não usados.

Testes de memória cobrem transporte, lock, conflito de checksum, histórico falho,
recusa de dados de apuração, conclusão e bloqueio após falha parcial. Testes Fantasy
cobrem motor, contribuições, persistência simulada, ranking e privacidade HTTP.

## Conteúdo local excluído

Credenciais, .env, logs, dumps, JSONs de homologação, estados .phase5b2 e executores
pontuais 3D/3E/3F/3G não fazem parte da publicação. Helpers reutilizáveis exigidos
por imports foram separados dos executores temporários, preservados localmente.
Os CLIs de manutenção local mantêm suas restrições de destino e autorização;
não são chamados pela inicialização de produção.

O contrato visual está em [point-fantasy-results-4b.md](point-fantasy-results-4b.md).

Valida??o final: 501 testes em 28 su?tes, lint, typecheck e build aprovados.
