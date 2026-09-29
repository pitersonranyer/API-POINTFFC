import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DesafioPartidaStatus, DesafioResultado, DesafioStatus, DesafioTipoAcesso } from '@prisma/client';

export class DesafioResumoDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiProperty({ type: String, nullable: true }) descricao!: string | null;
  @ApiProperty({ enum: DesafioTipoAcesso }) tipoAcesso!: DesafioTipoAcesso;
  @ApiProperty({ example: '2.00', description: 'BRL como texto decimal com duas casas' }) valorInscricao!: string;
  @ApiProperty({ enum: DesafioStatus }) status!: DesafioStatus;
  @ApiProperty({ format: 'date-time' }) inicioInscricao!: string;
  @ApiProperty({ format: 'date-time' }) fimInscricao!: string;
  @ApiProperty({ format: 'date-time' }) dataInicio!: string;
  @ApiProperty({ format: 'date-time' }) dataFim!: string;
}

export class DesafioPartidaDto {
  @ApiProperty() id!: number;
  @ApiProperty() ordem!: number;
  @ApiProperty() nomeCompeticao!: string;
  @ApiProperty() nomeMandante!: string;
  @ApiProperty({ type: String, nullable: true }) logoMandanteUrl!: string | null;
  @ApiProperty() nomeVisitante!: string;
  @ApiProperty({ type: String, nullable: true }) logoVisitanteUrl!: string | null;
  @ApiProperty({ format: 'date-time' }) dataInicio!: string;
  @ApiProperty({ enum: DesafioPartidaStatus }) status!: DesafioPartidaStatus;
  @ApiProperty({ format: 'date-time', description: 'Instante de inicio desta partida; limite exclusivo para salvar palpites' })
  fechamentoEm!: string;
  @ApiProperty({ description: 'Considera autenticacao, estado do Desafio, elegibilidade e horario do servidor; false para anonimos' })
  podeAlterarPalpite!: boolean;
  @ApiPropertyOptional({ enum: DesafioResultado, nullable: true, description: 'Somente autenticado; null quando ainda nao palpitou' })
  meuPalpite?: DesafioResultado | null;
}

export class DesafioDetalheDto extends DesafioResumoDto {
  @ApiProperty({ type: [DesafioPartidaDto] }) partidas!: DesafioPartidaDto[];
}

export class DesafiosPaginacaoDto {
  @ApiProperty() pagina!: number;
  @ApiProperty() limite!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPaginas!: number;
}

export class DesafiosPaginaDto {
  @ApiProperty({ type: [DesafioResumoDto] }) itens!: DesafioResumoDto[];
  @ApiProperty({ type: DesafiosPaginacaoDto }) paginacao!: DesafiosPaginacaoDto;
}

export class DesafioPalpiteSalvoDto {
  @ApiProperty() desafioId!: number;
  @ApiProperty() partidaId!: number;
  @ApiProperty({ enum: DesafioResultado }) palpite!: DesafioResultado;
  @ApiProperty({ format: 'date-time' }) fechamentoEm!: string;
  @ApiProperty() podeAlterarPalpite!: boolean;
}
