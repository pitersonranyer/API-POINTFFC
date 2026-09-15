# Nomes populares dos clubes

## Escopo e origem do inventário

Entrega somente de backend: aliases, normalização e testes. Frontend, scheduler,
política de rodada de referência, integração Cartola e contratos HTTP não foram
alterados. Não há migration, backfill, execução de sync real ou deploy nesta entrega.

Inventário levantado em **15/09/2026**, por consultas somente de leitura ao banco
**de desenvolvimento configurado no workspace**. Não é uma auditoria do banco de
produção nem comprova a composição atual das competições em produção.

Os participantes são os times ligados às partidas da temporada atual persistida
de cada competição. `test/fixtures/futebol-clubes-conhecidos.json` guarda os IDs,
nomes originais e nomes curtos anteriormente persistidos desse levantamento.
O nome curto persistido não é necessariamente o shortName bruto do provider,
especialmente na BSA, que já possuía aliases.

## Implementação

- `futebol-clubes.ts` mantém os mesmos 20 aliases BSA e o resolvedor `nomesClube`.
- `futebol-clubes-internacionais.ts` cadastra explicitamente 167 aliases, cada um
  com `nome` e `nomeCurto`, indexados exclusivamente pelo externalId football-data.
- `mapTeam` aplica o mesmo resolvedor em todas as competições. Seu parâmetro de
  competição permanece aceito para compatibilidade, mas não decide nomes.
- O mesmo clube presente em CL e em uma liga usa uma única configuração. Não há
  matching por nome, sigla, slug, similaridade ou transformação automática de texto.
- `nomeOriginal` recebe exatamente `name` da resposta atual do provider, inclusive
  quando ele mudar. Não é um arquivo histórico de todos os nomes anteriores.
- Sem alias: `nome = name` e `nomeCurto = shortName ?? name`, sem interromper sync.

O fluxo existente já normaliza os times antes de `futebolTime.upsert`, cuja chave
é `externalId`, com restrição única no schema. Os nomes normalizados são usados
tanto em create como em update; futuras sincronizações reaplicam os aliases e
atualizam o original sem criar outra linha para um clube compartilhado.

**Os registros existentes receberão os nomes no próximo sync normal após esta
versão ser disponibilizada. Esta entrega não executa esse sync.**

O schema já possui `nomeOriginal`, `nome`, `nomeCurto` e externalId único. Não é
necessária alteração de banco ou contrato. O GET continua retornando os campos
que já expunha; nomeOriginal permanece preservado na persistência.

As regras Cartola permanecem no fluxo existente: IDs BSA conhecidos conservam seus
vínculos, IDs BSA desconhecidos conservam vínculo administrativo no update, e sync
internacional grava cartolaClubeId null. O mapa editorial não define Cartola.

## Cobertura do inventário

| Competição | Total de clubes | Com alias | Sem alias |
| --- | ---: | ---: | ---: |
| CL | 36 | 36 | 0 |
| PL | 20 | 20 | 0 |
| PD | 20 | 20 | 0 |
| SA | 20 | 20 | 0 |
| BL1 | 18 | 18 | 0 |
| FL1 | 18 | 18 | 0 |
| PPL | 18 | 18 | 0 |
| DED | 18 | 18 | 0 |
| ELC | 24 | 24 | 0 |
| BSA (preservada) | 20 | 20 | 0 |

Total: **187 aliases únicos**, sendo **167 internacionais novos** e **20 BSA
preservados**. A soma por competição conta clubes compartilhados mais de uma vez:
25 IDs desse inventário aparecem tanto na CL quanto em uma liga nacional.

**Clubes inventariados sem alias: nenhum.** Clubes que entrarem depois deste
levantamento usam fallback até receberem uma definição editorial explícita.

## Exemplos

| externalId | nomeOriginal | nome | nomeCurto |
| ---: | --- | --- | --- |
| 108 | FC Internazionale Milano | Inter de Milão | Inter |
| 66 | Manchester United FC | Manchester United | Manchester United |
| 524 | Paris Saint-Germain FC | Paris Saint-Germain | PSG |
| 5 | FC Bayern München | Bayern de Munique | Bayern |
| 78 | Club Atlético de Madrid | Atlético de Madrid | Atlético |
| 5527 | Académico de Viseu FC | Académico de Viseu | Acad. Viseu |
| 1912 | Telstar 1963 | Telstar | Telstar |
| 1126 | Lincoln City FC | Lincoln City | Lincoln City |

Os nomes são escolhas editoriais explícitas, usando o inventário para associar
identidade e ID. A identidade AEK/Athens foi conferida na
[UEFA](https://www.uefa.com/uefachampionsleague/history/clubs/50129--aek-athens/),
e NEC/Nijmegen na
[UEFA](https://www.uefa.com/uefaeuropaleague/news/01d4-0e70a32d7e2c-f53e6f89ebb3-1000--nec-ride-luck-to-secure-progress/).
Os IDs UEFA não foram usados como externalId; a chave continua sendo a do
inventário football-data. Essas fontes não substituem a definição editorial
PointFFC nem comprovam a cobertura da produção.

## Validação automatizada

- Cobertura de todos os IDs de cada competição na fixture, sem colisão com BSA.
- Exemplos editoriais famosos e de clubes menores.
- Mesmo ID entre competições; mudanças no nome bruto não alteram o alias.
- Fallback com nome/sigla/slug parecidos com clube conhecido, inclusive shortName null.
- Preservação dos 20 nomes BSA e ausência de vínculo Cartola internacional.
- Sync PL/CL com persistência em memória: reaplicação de aliases, atualização do
  original e reutilização do mesmo ID local, sem duplicação.
- Testes Cartola existentes preservados, incluindo vínculo administrativo BSA.

Não são necessários bancos ou serviços externos para esses testes.
