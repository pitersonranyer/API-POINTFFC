import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ConfirmTelegramLinkDto {
  @ApiProperty({ example: '0123456789abcdef0123456789abcdef0123456789abcdef' })
  @IsString()
  @MinLength(48)
  @MaxLength(48)
  @Matches(/^[a-f0-9]{48}$/i)
  code!: string;
}
