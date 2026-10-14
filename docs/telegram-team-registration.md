# Cadastro de times Cartola no Telegram

## Regra de associação confirmada

A inspeção do fluxo efetivo encontrou que `MeusTimesService.adicionarTime` não fazia consulta de associação global: tratava somente o `P2002` da chave composta `(USUARIO_ID, TIME_ID)`. A migration original e o schema permitiam o mesmo `TIME_ID` ligado a perfis distintos. Portanto, a suposta proteção mencionada na política do produto não estava presente nessa camada do backend.

A regra foi centralizada no serviço existente e reforçada com índice `UNIQUE(TIME_ID)` em `0022_unique_cartola_team_profile`. A gravação continua idempotente para o próprio perfil. Se outro perfil já associou o time, o serviço devolve o status genérico existente sem retornar o ID ou qualquer dado do perfil que o possui. A constraint do MySQL é a autoridade concorrente entre processos/instâncias; checagem somente em memória ou `findFirst` antes do `create` não seria suficiente.

Antes de aplicar a migration em qualquer ambiente com dados, verificar duplicidades:

```sql
SELECT `TIME_ID`, COUNT(*) AS `QUANTIDADE`
FROM `TIME_USUARIO`
GROUP BY `TIME_ID`
HAVING COUNT(*) > 1;
```

A migration não apaga nem escolhe automaticamente um proprietário. Se a consulta retornar linhas, interromper a publicação e resolver cada associação segundo decisão de negócio antes de repetir a migration. A migration adiciona o índice único e remove o índice não único anterior de `TIME_ID`.

## Fluxo Telegram

A consulta pública Cartola (`CartolaService.getTeamById`) é usada apenas para exibir uma prévia verificada pelo ID solicitado. Ela não comprova titularidade e não é tratada como autorização. Na confirmação explícita, o serviço valida novamente o vínculo Telegram ativo, consulta o time Cartola sem cache e reutiliza `MeusTimesService.adicionarTime`; a constraint única impede associação a outro perfil.

A sessão de seleção gratuita existente guarda o contexto da competição, IDs selecionados e o candidato consultado. O cadastro reutiliza o mesmo token, nonce, chat, mensagem e prazo de expiração. Mensagens numéricas só são interpretadas na etapa de entrada do ID. Uma resposta incerta de persistência é verificada pela associação do usuário antes de reportar sucesso, sem repetir a escrita. O retorno à competição consulta novamente elegibilidade e lista de times. Nenhuma inscrição é criada automaticamente.

Não existe um limite global de times por perfil definido em `MeusTimesService`; o limite de lote (50) pertence ao serviço de inscrições e não foi reaproveitado como limite de cadastro.
