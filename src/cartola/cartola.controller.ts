import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBadGatewayResponse, ApiBadRequestResponse, ApiBody, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CartolaService } from './cartola.service';
import { CachedResult } from './cartola.types';
import { RoundParamsDto } from './dto/round-params.dto';
import { TeamIdParamsDto } from './dto/team-id-params.dto';
import { TeamIdsBodyDto } from './dto/team-ids-body.dto';
import { TeamSearchQueryDto } from './dto/team-search-query.dto';
import { SeasonQueryDto } from './dto/season-query.dto';

@ApiTags('cartola')
@ApiBadGatewayResponse({ description: 'Falha na API do Cartola sem fallback disponível' })
@ApiServiceUnavailableResponse({ description: 'Timeout da API do Cartola sem fallback disponível' })
@Controller('cartola')
export class CartolaController {
  constructor(private readonly cartola: CartolaService) {}

  @Get('mercado/status') @ApiOperation({ summary: 'Retorna o estado original do mercado Cartola' }) @ApiOkResponse({ description: 'Estado atual do mercado' })
  async marketStatus(@Res({ passthrough: true }) response: Response) { return this.respond(response, await this.cartola.getMarketStatus()); }

  @Get('atletas/mercado') @ApiOperation({ summary: 'Retorna atletas disponíveis no mercado' }) @ApiOkResponse({ description: 'Mercado de atletas' })
  async marketAthletes(@Res({ passthrough: true }) response: Response) { return this.respond(response, await this.cartola.getMarketAthletes()); }

  @Get('atletas/pontuados') @ApiOperation({ summary: 'Retorna pontuações parciais ou finais dos atletas' }) @ApiOkResponse({ description: 'Atletas pontuados' })
  async scoredAthletes(@Res({ passthrough: true }) response: Response) { return this.respond(response, await this.cartola.getScoredAthletes()); }

  @Get('atletas/pontuados/:rodada') @ApiOperation({ summary: 'Retorna atletas pontuados de uma rodada específica' }) @ApiParam({ name: 'rodada', schema: { type: 'integer', minimum: 1, maximum: 38 } }) @ApiOkResponse({ description: 'Atletas pontuados da rodada informada' })
  async scoredAthletesByRound(@Param() params: RoundParamsDto, @Res({ passthrough: true }) response: Response, @Query() query: SeasonQueryDto = {}) {
    return this.respond(response, await (query.temporada === undefined ? this.cartola.getScoredAthletes(params.rodada) : this.cartola.getScoredAthletes(params.rodada, query.temporada)));
  }

  @Get('clubes') @ApiOperation({ summary: 'Retorna os clubes do Cartola' }) @ApiOkResponse({ description: 'Clubes' })
  async clubs(@Res({ passthrough: true }) response: Response) { return this.respond(response, await this.cartola.getClubs()); }

  @Get('times')
  @ApiOperation({ summary: 'Busca times do Cartola pelo nome' })
  @ApiQuery({ name: 'nome', example: 'Meu Time', description: 'Nome do time, com no mínimo 2 caracteres' })
  @ApiOkResponse({ description: 'Lista de times encontrados; nomes não são necessariamente únicos' })
  @ApiBadRequestResponse({ description: 'Nome ausente, vazio ou curto demais' })
  async searchTeams(@Query() query: TeamSearchQueryDto, @Res({ passthrough: true }) response: Response) {
    return this.respond(response, await this.cartola.searchTeams(query.nome));
  }

  @Post('times/buscar-por-ids')
  @HttpCode(200)
  @ApiOperation({ summary: 'Busca até 50 times do Cartola por IDs, com resultados parciais' })
  @ApiBody({ schema: { oneOf: [
    { type: 'object', properties: { timeIds: { type: 'array', items: { type: 'integer', minimum: 1 }, example: [123456, 789012] } }, required: ['timeIds'] },
    { type: 'object', properties: { timeIds: { type: 'string', example: '123456;789012;345678' } }, required: ['timeIds'] },
  ] } })
  @ApiOkResponse({ description: 'Times encontrados, IDs inexistentes e falhas externas separados' })
  @ApiBadRequestResponse({ description: 'Lista inválida, vazia ou com mais de 50 IDs únicos' })
  async teamsByIds(@Body() body: TeamIdsBodyDto, @Res({ passthrough: true }) response: Response) {
    return this.respond(response, await this.cartola.getTeamsByIds(body.timeIds));
  }

  @Get('times/:timeId')
  @ApiOperation({ summary: 'Busca um time do Cartola pelo ID' })
  @ApiParam({ name: 'timeId', example: 123456, schema: { type: 'integer', minimum: 1 } })
  @ApiOkResponse({ description: 'Payload público do time' })
  @ApiBadRequestResponse({ description: 'ID ausente, não inteiro ou menor que 1' })
  @ApiNotFoundResponse({ description: 'Time não encontrado no Cartola' })
  async teamById(@Param() params: TeamIdParamsDto, @Res({ passthrough: true }) response: Response) {
    return this.respond(response, await this.cartola.getTeamById(params.timeId));
  }

  @Get('partidas') @ApiOperation({ summary: 'Retorna as partidas da rodada atual' }) @ApiOkResponse({ description: 'Rodada, clubes e partidas' })
  async matches(@Res({ passthrough: true }) response: Response) { return this.respond(response, await this.cartola.getMatches()); }

  @Get('partidas/:rodada') @ApiOperation({ summary: 'Retorna as partidas de uma rodada específica' }) @ApiParam({ name: 'rodada', schema: { type: 'integer', minimum: 1, maximum: 38 } }) @ApiOkResponse({ description: 'Rodada, clubes e partidas' })
  async matchesByRound(@Param() params: RoundParamsDto, @Res({ passthrough: true }) response: Response, @Query() query: SeasonQueryDto = {}) {
    return this.respond(response, await (query.temporada === undefined ? this.cartola.getMatchesByRound(params.rodada) : this.cartola.getMatchesByRound(params.rodada, query.temporada)));
  }

  @Get('dashboard') @ApiOperation({ summary: 'Retorna mercado, estado resumido, partidas e clubes para o Dashboard' }) @ApiOkResponse({ description: 'Visão agregada do Dashboard' })
  async dashboard(@Res({ passthrough: true }) response: Response) { return this.respond(response, await this.cartola.getDashboard()); }

  private respond<T>(response: Response, result: CachedResult<T>): T {
    response.setHeader('X-Cartola-Cache', result.cache);
    response.setHeader('X-Cartola-Stale', String(result.stale));
    return result.value;
  }
}
