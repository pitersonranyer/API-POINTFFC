import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminLigaDto, AdminLigaModalidadeDto } from './dto/admin-ligas.dto';

@Injectable()
export class AdminLigasService {
  constructor(private readonly prisma: PrismaService) {}

  listar(): Promise<AdminLigaDto[]> {
    return this.prisma.liga.findMany({
      select: { id: true, nome: true, slug: true, tipo: true, status: true, visivelApp: true, imagemUrl: true },
      orderBy: [{ nome: 'asc' }, { id: 'asc' }],
    });
  }

  async listarModalidades(ligaId: number): Promise<AdminLigaModalidadeDto[]> {
    const liga = await this.prisma.liga.findUnique({ where: { id: ligaId }, select: { id: true } });
    if (!liga) throw new NotFoundException('Liga nao encontrada.');
    const vinculos = await this.prisma.ligaModalidade.findMany({
      where: { ligaId },
      select: { id: true, modalidadeId: true, ativa: true, ordem: true,
        modalidade: { select: { codigo: true, nome: true } } },
      orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
    });
    return vinculos.map(({ id, modalidade, ...vinculo }) => ({
      ligaModalidadeId: id, ...vinculo, ...modalidade,
    }));
  }
}
