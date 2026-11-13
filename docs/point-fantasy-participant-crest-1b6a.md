# Identidade visual do participante — 1B.6A

Persistência: `Usuario.fantasyBrasaoId`, nullable, VARCHAR(40). Uma preferência por usuário, sem cópias nas identidades por competição ou escalações. Migration aditiva `0033_point_fantasy_participant_crest`; aplicar antes de executar esta versão da API. Nenhum backfill necessário. A migration não foi aplicada a bancos nesta entrega.

Rotas autenticadas com JWT (usuário bloqueado recebe 403):

- `GET /point-fantasy/brasoes`: `{ "versao": "v1", "items": [{ "id": "v1:c0:p0", "color": "#146b46", "variant": 0 }, ...] }`.
- `GET /point-fantasy/participante/brasao`: `{ "brasaoId": "v1:c0:p0", "escolhido": false }` (ID ilustrativo: fallback depende do usuário).
- `PATCH /point-fantasy/participante/brasao`, corpo `{ "brasaoId": "v1:c3:p2" }`: `{ "brasaoId": "v1:c3:p2", "escolhido": true }`.

Não há parâmetro de usuário: somente `idUsuario` do JWT autenticado define o destino. IDs ausentes, null, imagens, URLs e versões desconhecidas recebem 400. Não há reset nesta fase. GET e PATCH da preferência usam `private, no-store`.

O catálogo v1 é imutável: `v1:c{0..3}:p{0..2}`. Cores, nessa ordem: #146b46, #1b3028, #a77c20, #222222. Padrões: 0 diagonais, 1 verticais, 2 faixa horizontal. Referência inspecionada: `UI-POINTFFC/src/components/point-fantasy/lineups/TeamCrest.tsx`. Preservar geometria, contorno dourado e FFC desse SVG. Para uma identidade integralmente compartilhada, substituir o número de escalação do SVG por um símbolo fixo. A API persiste apenas o ID; não persiste nem retorna SVG.

Campo aditivo `brasaoId` em cada escalação nas respostas de criação, duplicação, edição, listagem pessoal e detalhe; também em cada item de ranking antes e depois do fechamento. A leitura usa a relação `usuario` com seleção apenas da preferência, evitando N+1 e exposição dos dados do usuário. Resultado, nome público, sequência e identidade textual permanecem com os mesmos significados. A confirmação de inscrições mantém seu contrato e replay existentes.

Sem preferência, SHA-256 de `point-ffc:participant-crest:v1:{idUsuario}`, primeiro uint32 big-endian módulo 12, escolhe uma entrada do catálogo sem gravar nada. Não depende de Cartola, competição, nome ou escalação. O cliente deve usar o ID retornado, sem precisar do ID privado do usuário ou recalcular o fallback. Colisões visuais entre participantes são permitidas.

Integração APP-POINTFFC: consumir catálogo para exibir seletor, consultar/salvar preferência usando Bearer JWT e renderizar `brasaoId` recebido em todos os contextos. Após PATCH, invalidar/refazer consultas de times, detalhe e ranking. Consumidores antigos podem ignorar o campo novo; consumidores novos devem tolerar sua ausência durante rollout. Não reutilizar a antiga chave SVG baseada em competição/escalação, nem importar escudos Cartola. Não houve alterações no APP nesta entrega.

Validação executada: `tsc --noEmit`, `prisma validate` e `git diff --check` aprovados. Jest com `--runInBand --roots src test --runTestsByPath`: 7 suítes, 135 testes aprovados (`participant-crest`, `team-identity`, `ranking`, `result-ranking`, `lineup.service`, `lineup.controller`, `controller`). Cobertura inclui ausência, catálogo/IDs válidos e inválidos, troca entre sessões, JWT ausente/inválido/bloqueado, tentativa de trocar outro usuário, compartilhamento entre competições, duplicação, preservação textual e leituras de ranking sem N+1. Os testes usam mocks; migration/persistência SQL real não foram executadas. `prisma generate` atualizou os tipos, mas falhou ao substituir `query_engine-windows.dll.node` com EPERM; repetir após liberar o processo que mantém a DLL em uso, antes de rodar a aplicação.

Arquivos desta fase: `prisma/schema.prisma`; `prisma/migrations/0033_point_fantasy_participant_crest/migration.sql`; `src/point-fantasy/participant-crest.ts`; `src/point-fantasy/participant-crest.controller.ts`; `src/point-fantasy/point-fantasy.module.ts`; `src/point-fantasy/point-fantasy.service.ts`; `src/point-fantasy/lineups/lineup.service.ts`; `src/point-fantasy/README.md`; `test/point-fantasy-participant-crest.spec.ts`; `test/point-fantasy-team-identity.spec.ts`; `test/point-fantasy-ranking.spec.ts`; `test/point-fantasy-result-ranking.spec.ts`; este documento. Sem commit, push, PR ou deploy.
