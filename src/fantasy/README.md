# Central da Partida — API Futebol V2

Integração do módulo Fantasy com https://api.api-futebol.com.br/v2, via Bearer e ConfigService. Sem persistência, polling, retries automáticos ou fallback de fornecedor.

## Rotas e identificação

- GET /fantasy/partidas/:fixtureId/pre-jogo
- GET /fantasy/partidas/:fixtureId/sumario
- GET /fantasy/partidas/:fixtureId/formacao
- GET /fantasy/partidas/:fixtureId/estatisticas

fixtureId é exclusivamente o ID da API Futebol V2. Nunca passar IDs da POC antiga ou de football-data.org. As respostas identificam partida.fornecedor = API_FUTEBOL_V2. Os caminhos foram preservados, mas a origem dos IDs mudou: migrar explicitamente a seleção de partidas antes da publicação.

## Contratos normalizados

Tipos públicos: PreJogoPartida, SumarioPartida, FormacaoPartida e EstatisticasPartida em fantasy.types.ts. São inferidos dos mappers; nenhum envelope externo é publicado.

Pré-jogo: partida com campeonato, temporada, rodada, fase, equipes, data ISO, timezone, estádio/cidade, status normalizado e original, período, minuto, acréscimos e placar. escalacoesDisponiveis e escalacoes por lado com provavel/confirmada; desfalquesInformados e desfalques com atleta, equipe, situacao, motivo e atualizadoEm. Lista vazia não certifica ausência de desfalques. Cada escalação conserva atualizadoEm; não existe timestamp global inventado.

Sumário: partida, eventosDisponiveis/eventos e narrativaDisponivel/narrativa. Eventos ordenados por período, minuto e acréscimo, com desempate estável. Substituição no intervalo mantém minuto null. Inclui amarelos, vermelhos, VAR, jogador, assistência, entra/sai e comissão técnica. Minutos permanecem locais ao período. Narrativa mantém ordem recebida, IDs, segundos e período original, com alias normalizado separado. Eventos e narrativa não são mesclados nem deduplicados por minuto. Não há placar acumulado calculado por evento.

Formação: partida, mandante/visitante com disponivel, tipoEscalacao, formacao, treinador, titulares, reservas e atualizadoEm; substituicoes separadas. Prefere confirmada, depois provável, por equipe. Jogadores conservam numero, posicao e grid e acrescentam foto, funcaoPartida e coordenada. posicaoCadastral permanece null quando não houve consulta ao cadastro independente; nunca inferir cadastro do rótulo da escalação. Não há consulta por atleta nem coordenadas inventadas.

Estatísticas: partida, mandante/visitante com disponivel, estatisticas (mesmos 18 nomes principais da POC), atletas e porTempo. Valores ausentes/nulos permanecem null; zero válido é preservado. passesCertos não é calculado a partir de percentual. xG da equipe usa somente gols_esperados; gols_esperados_total não é publicado. Gols por tempo são excluídos pela inconsistência da homologação. porTempo só publica escanteios e cartões; não existem filtros de requisição por período. Atletas têm identidade, função, titularidade, indicador de goleiro e métricas numéricas em camelCase, com lista explícita de campos aceitos. Estatísticas de goleiro ficam em goleiroEstatisticas.

## Cache e consumo

Cliente singleton do FantasyModule. Cache por caminho e ID V2 compartilhado no processo, com cópias de retorno. Compartilha detalhe entre abas e agrupa chamadas simultâneas idênticas. Limite de 500 entradas; tabela de estados também limitada a 500 IDs.

| Configuração | Default |
|---|---:|
| API_FUTEBOL_V2_TIMEOUT_MS | 15000 |
| API_FUTEBOL_V2_TTL_PRE_MS | 300000 |
| API_FUTEBOL_V2_TTL_LIVE_MS | 60000 |
| API_FUTEBOL_V2_TTL_FINAL_MS | 3600000 |

Timeout inclui leitura do corpo. Estados andamento/suspenso usam TTL ao vivo; finalizado/cancelado/abandonado/wo usam final; demais usam pré-jogo. Mudanças de estado são observadas após expirar o detalhe: TTL pré-jogo também limita a detecção do início. Calibrar defaults conforme quota e latência desejada.

Chamadas distintas são serializadas para observar o saldo antes de ampliar consumo. Headers X-RateLimit, Retry-After e metadata.requisicoes controlam bloqueio por saldo zero/429. Sem reset válido, usa espera conservadora de 60 segundos. Cache válido continua disponível; não se entrega payload expirado silenciosamente. O limite observado de 1000 não é constante da implementação.

Cache e bloqueio não são compartilhados entre instâncias. Antes de escalar horizontalmente, adotar coordenação de quota/cache e orçamento para as rotas públicas. Não existe polling automático.

Erros: ID inválido 400; chave ausente, credencial recusada, quota ou 5xx externo 503; partida inexistente 404; conexão/JSON/envelope inválido 502; timeout 504. Mensagens externas e credenciais não são logadas ou devolvidas. Redirects são rejeitados.

## Inspeção e remoção

Cliente antigo e mapper eram consumidos somente por FantasyService, FantasyModule e testes locais. Removidos cliente, mapper, diagnósticos temporários e seis suítes antigas, substituídos por testes V2. Não havia dependência npm exclusiva a remover.

Configuração antiga removida da validação; .env e variáveis de produção não foram alterados. src/futebol usa FootballDataClient/football-data.org para sincronização e desafios: preservado. Campos persistidos com sufixo ApiFootball em Prisma, admin, desafios e testes são legados compartilhados: preservados sem migrations e sem reinterpretar IDs.

## Compatibilidade e UI

Frontend não alterado. Preservados caminhos e estruturas principais de equipes, totais e formação. Revisar IDs novos, status PRE_JOGO, posições descritivas em vez de códigos antigos, tipos novos de eventos, ausência de placarAposEvento calculado, minuto local ao período e indicadores de indisponibilidade. A UI deve selecionar a partida a partir da API Futebol; não há conversão implícita.

Permanecem limitações: posições divergentes, coordenadas ausentes em prováveis, escalações futuras null, acréscimos divergentes entre fontes, xG individual frequentemente null, cobertura por tempo parcial e nulabilidade divergente no OpenAPI. VAR e comissão técnica ainda exigem exemplos positivos reais; testes dessas formas não comprovam cobertura do fornecedor. Dados cadastrais independentes permanecem indisponíveis sem consulta específica.

## Validação local

Fixtures em test/helpers/api-futebol-v2.fixture.ts são recortes baseados nos formatos/valores observados em 321 e 340, com campos não necessários omitidos ou anulados. Não são snapshots completos nem fallback público. Testes unitários não acessam rede, banco ou bootstrap. Não iniciar main.ts para testar: o bootstrap executa migrations.

Verificação isolada do serviço compilado com cinco GETs reais: partida 321, 11 titulares mandantes, 17 eventos, 76 lances, posse mandante 67 e 23 atletas mandantes; partida futura 340 com escalações indisponíveis e nove desfalques. Sem inicializar AppModule ou acessar banco.
