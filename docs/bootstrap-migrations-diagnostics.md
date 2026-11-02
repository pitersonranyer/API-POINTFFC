# Diagnóstico do bootstrap de migrations

Cada linha JSON usa `event: "bootstrap_migrations"`, `stage`, `result`
(`started`, `succeeded`, `failed`), `duration_ms` e `previous_stage`.
Falhas acrescentam `error_code` e `error_type`, ambos sanitizados por listas
permitidas. Mensagens, stacks, URLs, SQL, caminhos e conteúdo de certificados
não são registrados. Códigos ou tipos desconhecidos aparecem como `UNKNOWN`
e `UnknownError`. A saída bruta do Prisma CLI fica capturada em memória e não
é encaminhada ao console; somente seu marcador de erro Prisma pode ser extraído.

Sequência normal com 0030 pendente:

1. `bootstrap`
2. `artifact_validation`
3. `client_connection`
4. `lock_acquire`
5. `migration_history`
6. `temporary_schema`
7. `cli_through_0029`
8. `migration_boundary`
9. `observation_guard`
10. `migration_0030_history_start`
11. `cli_transport_0030`
12. `migration_0030_verify`
13. `migration_0030_history_complete`
14. `cli_post_0030`
15. `lock_release`
16. `client_disconnect`
17. `bootstrap` concluído

Se 0030 já estiver aplicada, as etapas 6–13 não são executadas. Se seu transporte
ou sua verificação falhar, a etapa existente de registro da falha aparece como
`migration_0030_history_failure`. Nenhuma operação de banco foi adicionada.

`client_connection` mede a abertura da transação já existente até a entrada no
callback; inclui obtenção de conexão e início da transação. Não há novo `$connect()`.
`lock_release` indica que a consulta de liberação retornou sem erro, preservando
o comportamento anterior, que não interpreta o valor retornado por `RELEASE_LOCK`.

Para localizar P1001, procurar o primeiro evento `failed` com `error_code: "P1001"`.
O evento da etapa precede a limpeza e o encerramento geral. Falhas posteriores na
limpeza têm eventos próprios e preservam o fluxo de propagação anterior.
`previous_stage` descreve a última etapa finalizada, não o estágio pai.
Se o processo for interrompido abruptamente, o último `started` sem conclusão
delimita o ponto de interrupção, mas não comprova sua causa.

A instrumentação não muda SQL, schema, histórico, sequência de comandos, locks,
transações, conexões ou política de falhas. O diagnóstico exato de produção ainda
depende dos eventos coletados no Render após uma publicação autorizada.

## Caminhos TLS no CLI

Antes de iniciar cada subprocesso Prisma CLI, o bootstrap cria uma cópia do
ambiente e resolve valores relativos de `sslcert` e `sslidentity` em relação ao
diretório do schema original (`prisma/`). Isso mantém o acesso aos mesmos arquivos
quando o CLI usa o schema temporário. A variável global `DATABASE_URL` e o Prisma
Client permanecem inalterados. Caminhos absolutos e URLs sem arquivos TLS são
preservados; os demais trechos da URL, inclusive credenciais, `sslpassword`,
`sslaccept`, opções repetidas e escaping, não são reserializados.

O ajuste não cria certificados, não ignora arquivos ausentes e não altera a
validação TLS. Um arquivo inexistente ou sem permissão continua sendo uma falha.
Os testes usam arquivos fictícios e subprocessos sem banco para verificar que o
schema temporário encontra os mesmos arquivos do schema original. Eles eliminam
a condição de arquivo perdido reproduzida localmente, sem provar a causa do erro
do Render nem testar um handshake TLS de produção.

Na verificação adicional com `schema-engine` 5.22, comando
`can-connect-to-database`, endereço `127.0.0.1` e credenciais fictícias, o mesmo
contexto temporário retornou P1001 antes da normalização e P1011 depois dela.
O arquivo passou a ser encontrado; a falha TLS própria do ambiente Windows local
permaneceu. Isso não representa uma conexão completa bem-sucedida nem comprova
a causa do incidente em produção. Nenhuma migration foi executada nesse teste.
