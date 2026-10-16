import { BadRequestException } from '@nestjs/common';
import { randomInt } from 'crypto';

export const PUBLIC_TEAM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PUBLIC_TEAM_CODE_ATTEMPTS = 5;

// Display identifier only: authorization always uses JWT and ownership checks.
export function generatePublicTeamCode(): string {
  return Array.from({ length: 7 }, () => PUBLIC_TEAM_CODE_ALPHABET[randomInt(PUBLIC_TEAM_CODE_ALPHABET.length)]).join('');
}

// Internal signal: retry only a collision on the public-code unique index.
export class PublicTeamCodeCollision extends Error {}

export function normalizeTeamName(value: unknown = 'Meu Time'): string {
  if (typeof value !== 'string' || value.length > 120) throw new BadRequestException('Nome-base invalido');
  const name = value.normalize('NFC').trim().replace(/ +/g, ' ');
  if ([...name].length < 2 || [...name].length > 60
    || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'-]*$/u.test(name)) {
    throw new BadRequestException('Nome-base deve ter 2 a 60 caracteres: letras, numeros, espacos, ponto, apostrofo ou hifen');
  }
  return name;
}
