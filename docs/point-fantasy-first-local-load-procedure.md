# Primeira carga local: procedimento para autorização

Status posterior: [0029/0030 aplicadas e corte/backfill concluídos localmente](point-fantasy-local-deployment.md).
O texto abaixo preserva o procedimento e os resultados da preparação original.

Destino exclusivo: `127.0.0.1:3306/fantasy_point_do_jogador`.
Branch: `feat/point-fantasy-scoring-observation-3b2`.
Esta preparação não autoriza nem executa alterações no principal ou HTTP ao Cartola.

## Artefatos vinculados ao ensaio

Diretório de evidências: `C:/Users/piter/AppData/Local/Temp/point-ffc-local-preparation-Lcsrs1`.
O `plan.json` identifica servidor por `@@server_uuid`, host/porta/schema, todos os
checksums, histórico completo, backup e seu SHA-256, dados anteriores e estrutura
esperada após cada instrução. `results.json` e `executor-tests.json` registram o resultado.
`authorization.json` nasce com `authorized: false` e `writersStopped: false`.
Não contém senha; a conexão vem de `DATABASE_URL` local. Backup contém dados locais.

Resultado final em 21/10/2026: backup consistente InnoDB por single-transaction,
restauração verificada contra dados/DDL do principal, 7 testes do executor e
16 testes de exclusividade aprovados, Prisma validate e typecheck aprovados.
Houve uma falha intermediária de preservação de logs na recuperação; corrigida,
com novo backup/restaurações e repetição integral dos 7 testes. Evidências anteriores
foram mantidas. Dados/estrutura do principal permaneceram idênticos antes/depois.
Nenhuma migration histórica, coletor, serviço ou barreira existente foi alterado.

Pré-requisito confirmado: 0001–0028 aplicadas; somente 0029/0030 pendentes. O histórico
também contém tentativas já revertidas de 0007/0023, preservadas integralmente.

| Migration | SHA-256 exato dos bytes do arquivo |
|---|---|
| 0029_point_fantasy_current_scoring | `df2a5744867641f015ed6e28d447d66ffd705f589ec7c6f2c270d12f913e9c48` |
| 0030_point_fantasy_writer_admission | `57b2cb49a10f6a33e6673196fed5986fee120431f3aebeb93f26b57b4d936bb8` |

0029 depende da estrutura 0028 e acrescenta o modelo ATUAL, referências, índices e
CHECKs. 0030 depende dessas colunas/tabelas e instala controle/auditoria, 18 triggers
e três procedures. O executor verifica as dependências pela estrutura completa
restaurada, além do histórico e dos checksums, e executa somente 0029 → 0030.

## Histórico anterior preservado

As diferenças de proveniência abaixo são reconhecidas explicitamente, não corrigidas:

| Migration | Checksum registrado | Checksum do arquivo local |
|---|---|---|
| 0024 | `01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4` | `3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0` |
| 0025 | `d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b` | `7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2` |

Qualquer divergência adicional interrompe a execução. Não editar arquivos antigos,
checksums ou registros anteriores; não usar reset, resolve sobre 0024/0025 ou deploy geral.

## Aplicação, somente após autorização explícita

1. Manter todos os escritores locais parados, incluindo processos/CLIs antigos e
   rotinas da aplicação, durante toda a janela DDL. Identificar operador e confirmar
   que não existem coletas EM_ANDAMENTO nem LOCK_TOKEN/LOCK_ATE preenchidos.
   O executor confere a drenagem, mas a ausência de leases não prova ausência de
   processos ociosos; a parada dos processos deve ser confirmada pelo operador.
2. Confirmar o plano homologado, `sourceUnchanged: true`, backup disponível e a
   autorização do destino e da exceção histórica 0024/0025. Após a autorização,
   preencher `operator` e mudar os dois booleanos de `authorization.json` para `true`.
   O `planHash` deve continuar igual ao registrado em `results.json`.
3. No diretório do repositório, executar exatamente:

```powershell
node scripts/point-fantasy-local-migrations.cjs apply "C:\Users\piter\AppData\Local\Temp\point-ffc-local-preparation-Lcsrs1\plan.json" "C:\Users\piter\AppData\Local\Temp\point-ffc-local-preparation-Lcsrs1\authorization.json"
```

O comando não foi executado nesta preparação. Rejeita NODE_ENV=production, outro
servidor, branch, destino, alteração de artefato, backup, dados ou histórico, plano
não homologado e autorização ausente/desvinculada. Usa um lock de conexão para
serializar executores. Não inicia a aplicação nem seus schedulers.

O executor registra uma tentativa real em `_prisma_migrations` antes do DDL,
com UUID/checksum/started_at. Sucesso só recebe finished_at após verificação completa;
uma migration inteira corresponde a applied_steps_count=1. Falhas e instruções
concluídas são acumuladas em logs; nenhuma falha é registrada como sucesso.
Não utiliza `migrate deploy`.

## Falha e recuperação

DDL MySQL não é uma transação global. Não repetir SQL completo após falha parcial.
Manter escritores parados e a mesma autorização/plano. Para continuar:

```powershell
node scripts/point-fantasy-local-migrations.cjs recover "C:\Users\piter\AppData\Local\Temp\point-ffc-local-preparation-Lcsrs1\plan.json" "C:\Users\piter\AppData\Local\Temp\point-ffc-local-preparation-Lcsrs1\authorization.json"
```

A recuperação exige tentativa pendente com checksum exato e estrutura coincidente
com uma fronteira única do ensaio. Executa somente as instruções restantes,
verifica o resultado e chama Prisma 5.22 `migrate resolve --applied` apenas para a
migration efetivamente completada, por diretório temporário com arquivos idênticos
de 0029/0030. Prisma preserva a tentativa falha, marca-a revertida administrativamente
e cria o registro aplicado; isso não significa reversão do DDL. Os logs originais
permanecem. É o fluxo de [completar e resolver como aplicada](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing).

Estado não reconhecido, dados alterados ou backup divergente: parar; não forçar
resolve, remover objetos ou alterar o histórico. O backup foi restaurado em schema
isolado; ele não é restaurado automaticamente sobre o principal.

## Corte, backfill e primeira coleta: sequência preparada

As migrations não inicializam escopos nem habilitam coletores. Após sua aplicação,
os escopos sem controle ficam bloqueados inclusive para o escritor legado.

1. Com os processos legados ainda parados, inicializar explicitamente o controle do
   escopo autorizado em LEGADO, sem realizar uma coleta. Registrar operador,
   justificativa e UUID; reler modo/geração/revisão/hash/fence para cada operação.
2. Transicionar LEGADO → BLOQUEADO. Aguardar drenagem; nunca recuperar lease vivo.
   Recuperação de trabalho expirado exige auditoria e incremento de fence.
3. Se o escopo contém snapshot legado aceito, copiar a última origem com backfill
   SQL exato, sem conversão decimal para Number. Reexecutar para provar idempotência.
   O ensaio 2026/31 tem 275 atletas, 20 técnicos; isso não define a rodada da primeira
   coleta futura. Escopo comprovadamente vazio dispensa backfill, sem inventar snapshot.
4. Habilitar BLOQUEADO → ATUAL somente sem pendências e com referências atualizadas.
   Reativar LEGADO depois de ATUAL é proibido. Reiniciar apenas o escritor autorizado.
5. Para uma coleta real, confirmar temporada/rodada explicitamente e UUID único,
   alvo local, modo ATUAL/geração válidos, política parcial aceita, código compilado
   e fonte oficial configurada. Não alegar validação final por uma coleta parcial.

**Atualização operacional posterior:** há agora um [CLI de coleta ATUAL local](point-fantasy-local-collection-cli.md)
com autorização específica vinculada ao servidor/schema/temporada/rodada/UUID.
WriterAdmissionService e backfill continuam restritos aos schemas isolados. O CLI
não aplica migrations nem executa o corte; exige essas pré-condições já satisfeitas.
`point-fantasy-observe.cjs` continua usando LEGADO e é recusado no modo ATUAL.
A sequência de corte foi ensaiada no schema isolado, sem habilitação no principal.
