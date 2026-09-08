import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { SeasonQueryDto } from './season-query.dto';

export class TeamDetailQueryDto extends SeasonQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(38)
  rodada?: number;
}
