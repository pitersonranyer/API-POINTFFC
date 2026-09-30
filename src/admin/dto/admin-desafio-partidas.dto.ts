import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsDateString, IsInt, Matches, Max, Min } from 'class-validator';
import { AdminIdParamsDto } from './admin-common.dto';

export class PesquisarAdminFixturesDto {
  @ApiProperty({ example: '2026-10-01', description: 'Dia inicial inclusivo em UTC' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true })
  dataInicial!: string;

  @ApiProperty({ example: '2026-10-07', description: 'Dia final inclusivo em UTC; maximo de 7 dias' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true })
  dataFinal!: string;
}

export class AdicionarAdminDesafioPartidaDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(4294967295)
  fixtureId!: number;
}

export class ReordenarAdminDesafioPartidasDto {
  @ApiProperty({ type: [Number], example: [14, 11, 13, 12] })
  @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(4294967295, { each: true })
  partidaIds!: number[];
}

export class AdminDesafioPartidaParamsDto extends AdminIdParamsDto {
  @ApiProperty({ minimum: 1 })
  @Transform(({ value }) => typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : NaN)
  @IsInt() @Min(1) @Max(4294967295)
  partidaId!: number;
}
