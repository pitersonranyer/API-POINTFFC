import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class FirebaseSessionDto {
  @ApiProperty({ description: 'Firebase ID Token atualizado' })
  @IsString()
  @MinLength(20)
  idToken: string;
}
