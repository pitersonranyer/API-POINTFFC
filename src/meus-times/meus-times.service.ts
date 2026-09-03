import { Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma, TimeUsuario } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdicionarTimeDto } from './dto/adicionar-time.dto';
import { TimeUsuarioResponseDto } from './dto/time-usuario-response.dto';

export type AdicionarTimeResultado = { status: 'adicionado' | 'ja_existente'; timeId: number };
export type ImportarTimesResultado = {
  solicitados: number;
  adicionados: number;
  jaExistentes: number;
  falhas: Array<{ timeId: number | null; motivo: 'dados_invalidos' | 'erro_persistencia' }>;
  timesAdicionados: number[];
  timesJaExistentes: number[];
};

@Injectable()
export class MeusTimesService {
  constructor(private readonly prisma: PrismaService) {}

  async listarTimesDoUsuario(usuarioId: number): Promise<TimeUsuarioResponseDto[]> {
    const times = await this.prisma.timeUsuario.findMany({ where: { usuarioId }, orderBy: { criadoEm: 'desc' } });
    return times.map(TimeUsuarioResponseDto.from);
  }

  buscarTimeDoUsuario(usuarioId: number, timeId: number): Promise<TimeUsuario | null> {
    return this.prisma.timeUsuario.findUnique({ where: { usuarioId_timeId: { usuarioId, timeId } } });
  }

  async adicionarTime(usuarioId: number, dadosTime: AdicionarTimeDto): Promise<AdicionarTimeResultado> {
    try {
      await this.prisma.timeUsuario.create({ data: { usuarioId, ...dadosTime } });
      return { status: 'adicionado', timeId: dadosTime.timeId };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { status: 'ja_existente', timeId: dadosTime.timeId };
      }
      throw error;
    }
  }

  async removerTime(usuarioId: number, timeId: number): Promise<void> {
    const result = await this.prisma.timeUsuario.deleteMany({ where: { usuarioId, timeId } });
    if (result.count === 0) throw new NotFoundException('Time nao encontrado entre os times do usuario');
  }

  async adicionarTimesEmLote(usuarioId: number, times: unknown[]): Promise<ImportarTimesResultado> {
    const resultado: ImportarTimesResultado = {
      solicitados: times.length, adicionados: 0, jaExistentes: 0, falhas: [],
      timesAdicionados: [], timesJaExistentes: [],
    };

    for (const item of times) {
      if (!this.isRecord(item)) {
        resultado.falhas.push({ timeId: null, motivo: 'dados_invalidos' });
        continue;
      }
      const dto = plainToInstance(AdicionarTimeDto, item);
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      if (errors.length > 0) {
        resultado.falhas.push({ timeId: this.extractTimeId(item), motivo: 'dados_invalidos' });
        continue;
      }
      try {
        const added = await this.adicionarTime(usuarioId, dto);
        if (added.status === 'adicionado') {
          resultado.adicionados += 1;
          resultado.timesAdicionados.push(dto.timeId);
        } else {
          resultado.jaExistentes += 1;
          resultado.timesJaExistentes.push(dto.timeId);
        }
      } catch {
        resultado.falhas.push({ timeId: dto.timeId, motivo: 'erro_persistencia' });
      }
    }
    return resultado;
  }

  private extractTimeId(item: unknown): number | null {
    if (typeof item !== 'object' || item === null || !('timeId' in item)) return null;
    const value = (item as { timeId?: unknown }).timeId;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }

  private isRecord(item: unknown): item is Record<string, unknown> {
    return typeof item === 'object' && item !== null && !Array.isArray(item);
  }
}
