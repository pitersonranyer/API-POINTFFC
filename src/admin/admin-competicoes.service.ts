import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, CompeticaoTipoTaxaPlataforma, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AtualizarAdminCompeticaoDto, CriarAdminCompeticaoDto, DuplicarAdminCompeticaoDto, ListarAdminCompeticoesQueryDto } from './dto/admin-competicoes.dto';

const adminCompeticaoSelect = {
  id: true, ligaModalidadeId: true, nome: true, slug: true, descricao: true,
  tipoAcesso: true, valorInscricao: true, tipoTaxaPlataforma: true, valorTaxaPlataforma: true,
  rodadaInicio: true, rodadaFim: true, dataInicio: true, dataFim: true,
  inicioInscricao: true, fimInscricao: true, limiteTimesUsuario: true, limiteParticipantes: true,
  status: true, visivelApp: true, destaque: true, criadoEm: true, atualizadoEm: true,
  ligaModalidade: { select: {
    id: true,
    liga: { select: { id: true, nome: true, slug: true, status: true, visivelApp: true } },
    modalidade: { select: { id: true, codigo: true, nome: true, ativa: true } },
  } },
} satisfies Prisma.CompeticaoLigaSelect;

type CompeticaoRow = Prisma.CompeticaoLigaGetPayload<{ select: typeof adminCompeticaoSelect }>;
type EstadoCompeticao = Omit<Prisma.CompeticaoLigaUncheckedCreateInput, 'id' | 'criadoEm' | 'atualizadoEm'>;
type EscritaCompeticaoClient = Pick<Prisma.TransactionClient, 'ligaModalidade' | 'competicaoLiga'>;

const camposEstruturais: Array<keyof AtualizarAdminCompeticaoDto> = [
  'ligaModalidadeId', 'tipoAcesso', 'valorInscricao', 'tipoTaxaPlataforma', 'valorTaxaPlataforma',
  'rodadaInicio', 'rodadaFim', 'dataInicio', 'dataFim', 'inicioInscricao', 'fimInscricao',
  'limiteTimesUsuario', 'limiteParticipantes',
];

function mapear(row: CompeticaoRow): Record<string, unknown> {
  const { ligaModalidade, valorInscricao, valorTaxaPlataforma, dataInicio, dataFim,
    inicioInscricao, fimInscricao, criadoEm, atualizadoEm, ...dados } = row;
  return {
    ...dados,
    valorInscricao: valorInscricao.toNumber(),
    valorTaxaPlataforma: valorTaxaPlataforma?.toNumber() ?? null,
    dataInicio: dataInicio?.toISOString() ?? null,
    dataFim: dataFim?.toISOString() ?? null,
    inicioInscricao: inicioInscricao?.toISOString() ?? null,
    fimInscricao: fimInscricao?.toISOString() ?? null,
    criadoEm: criadoEm.toISOString(),
    atualizadoEm: atualizadoEm.toISOString(),
    liga: ligaModalidade.liga,
    modalidade: ligaModalidade.modalidade,
  };
}

function validarEstado(estado: EstadoCompeticao, validarDatas = true): void {
  const valorInscricao = new Prisma.Decimal(String(estado.valorInscricao));
  if (estado.rodadaInicio !== null && estado.rodadaInicio !== undefined && estado.rodadaInicio <= 0
    || estado.rodadaFim !== null && estado.rodadaFim !== undefined && estado.rodadaFim <= 0) {
    throw new BadRequestException('Rodadas devem ser positivas.');
  }
  if (estado.rodadaInicio !== null && estado.rodadaInicio !== undefined
    && estado.rodadaFim !== null && estado.rodadaFim !== undefined && estado.rodadaFim < estado.rodadaInicio) {
    throw new BadRequestException('rodadaFim deve ser maior ou igual a rodadaInicio.');
  }
  if (validarDatas && estado.dataInicio && estado.dataFim && estado.dataFim < estado.dataInicio) {
    throw new BadRequestException('dataFim deve ser maior ou igual a dataInicio.');
  }
  if (validarDatas && estado.inicioInscricao && estado.fimInscricao && estado.fimInscricao < estado.inicioInscricao) {
    throw new BadRequestException('fimInscricao deve ser maior ou igual a inicioInscricao.');
  }
  if (validarDatas && estado.fimInscricao && estado.dataInicio && estado.fimInscricao > estado.dataInicio) {
    throw new BadRequestException('fimInscricao nao pode ser posterior a dataInicio.');
  }
  if (estado.tipoAcesso === CompeticaoTipoAcesso.FREE && !valorInscricao.isZero()) {
    throw new BadRequestException('Competicao FREE deve ter valorInscricao igual a zero.');
  }
  if (estado.tipoAcesso === CompeticaoTipoAcesso.PAGO && !valorInscricao.gt(0)) {
    throw new BadRequestException('Competicao PAGO deve ter valorInscricao maior que zero.');
  }
  const tipoTaxa = estado.tipoTaxaPlataforma;
  const valorTaxa = estado.valorTaxaPlataforma === null || estado.valorTaxaPlataforma === undefined
    ? null : new Prisma.Decimal(String(estado.valorTaxaPlataforma));
  if ((tipoTaxa === null || tipoTaxa === undefined) !== (valorTaxa === null)) {
    throw new BadRequestException('Tipo e valor da taxa da plataforma devem ser informados juntos.');
  }
  if (valorTaxa?.lt(0)) throw new BadRequestException('Taxa da plataforma nao pode ser negativa.');
  if (tipoTaxa === CompeticaoTipoTaxaPlataforma.PERCENTUAL && valorTaxa?.gt(100)) {
    throw new BadRequestException('Taxa percentual deve estar entre zero e 100.');
  }
  if (estado.limiteTimesUsuario !== null && estado.limiteTimesUsuario !== undefined && estado.limiteTimesUsuario <= 0
    || estado.limiteParticipantes !== null && estado.limiteParticipantes !== undefined && estado.limiteParticipantes <= 0) {
    throw new BadRequestException('Limites devem ser maiores que zero.');
  }
}

@Injectable()
export class AdminCompeticoesService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(query: ListarAdminCompeticoesQueryDto): Promise<Record<string, unknown>> {
    const where: Prisma.CompeticaoLigaWhereInput = {
      ...(query.liga !== undefined || query.modalidade !== undefined ? { ligaModalidade: {
        ...(query.liga !== undefined ? { ligaId: query.liga } : {}),
        ...(query.modalidade !== undefined ? { modalidadeId: query.modalidade } : {}),
      } } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.visivel !== undefined ? { visivelApp: query.visivel } : {}),
      ...(query.busca ? { OR: [
        { nome: { contains: query.busca } }, { slug: { contains: query.busca } },
      ] } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.competicaoLiga.count({ where }),
      this.prisma.competicaoLiga.findMany({ where, select: adminCompeticaoSelect,
        orderBy: [{ atualizadoEm: 'desc' }, { id: 'desc' }],
        skip: (query.pagina - 1) * query.limite, take: query.limite }),
    ]);
    return { itens: rows.map(mapear), paginacao: {
      pagina: query.pagina, limite: query.limite, total, totalPaginas: Math.ceil(total / query.limite),
    } };
  }

  async buscar(id: number): Promise<Record<string, unknown>> {
    const row = await this.prisma.competicaoLiga.findUnique({ where: { id }, select: adminCompeticaoSelect });
    if (!row) throw new NotFoundException('Competicao nao encontrada.');
    return mapear(row);
  }

  async criar(dto: CriarAdminCompeticaoDto): Promise<Record<string, unknown>> {
    const estado: EstadoCompeticao = {
      nome: dto.nome, slug: dto.slug, descricao: dto.descricao ?? null,
      ligaModalidadeId: dto.ligaModalidadeId, tipoAcesso: dto.tipoAcesso,
      valorInscricao: dto.valorInscricao, tipoTaxaPlataforma: dto.tipoTaxaPlataforma ?? null,
      valorTaxaPlataforma: dto.valorTaxaPlataforma ?? null,
      rodadaInicio: dto.rodadaInicio ?? null, rodadaFim: dto.rodadaFim ?? null,
      dataInicio: dto.dataInicio ?? null, dataFim: dto.dataFim ?? null,
      inicioInscricao: dto.inicioInscricao ?? null, fimInscricao: dto.fimInscricao ?? null,
      limiteTimesUsuario: dto.limiteTimesUsuario ?? null, limiteParticipantes: dto.limiteParticipantes ?? null,
      status: dto.status ?? CompeticaoLigaStatus.RASCUNHO,
      visivelApp: dto.visivelApp ?? false, destaque: dto.destaque ?? false,
    };
    try {
      return await this.criarEstado(this.prisma, estado);
    } catch (error) { this.tratarErroPrisma(error); }
  }

  async duplicar(id: number, dto: DuplicarAdminCompeticaoDto): Promise<Record<string, unknown>> {
    try {
      return await this.prisma.$transaction(async tx => {
        const origem = await tx.competicaoLiga.findUnique({
          where: { id },
          select: {
            ligaModalidadeId: true, descricao: true, tipoAcesso: true, valorInscricao: true,
            tipoTaxaPlataforma: true, valorTaxaPlataforma: true,
            limiteTimesUsuario: true, limiteParticipantes: true, visivelApp: true, destaque: true,
          },
        });
        if (!origem) throw new NotFoundException('Competicao de origem nao encontrada.');
        return this.criarEstado(tx, {
          ...origem,
          nome: dto.nome, slug: dto.slug,
          rodadaInicio: dto.rodadaInicio, rodadaFim: dto.rodadaFim,
          dataInicio: dto.dataInicio, dataFim: dto.dataFim,
          inicioInscricao: dto.inicioInscricao, fimInscricao: dto.fimInscricao,
          status: CompeticaoLigaStatus.RASCUNHO,
        });
      });
    } catch (error) { this.tratarErroPrisma(error); }
  }

  async atualizar(id: number, dto: AtualizarAdminCompeticaoDto): Promise<Record<string, unknown>> {
    const atual = await this.prisma.competicaoLiga.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Competicao nao encontrada.');
    if (dto.ligaModalidadeId !== undefined) await this.validarLigaModalidade(this.prisma, dto.ligaModalidadeId);
    const estado = { ...atual, ...dto } as EstadoCompeticao;
    const alteraDatas = dto.dataInicio !== undefined || dto.dataFim !== undefined
      || dto.inicioInscricao !== undefined || dto.fimInscricao !== undefined;
    validarEstado(estado, alteraDatas);
    const inscricoesAtivas = await this.prisma.inscricaoTimeCompeticao.count({
      where: { competicaoLigaId: id, statusInscricao: 'ATIVA' },
    });
    if (inscricoesAtivas > 0) {
      const alterados = camposEstruturais.filter(campo => dto[campo] !== undefined
        && !this.mesmoValor(atual[campo as keyof typeof atual], dto[campo]));
      if (alterados.length) throw new ConflictException(`Competicao com inscricoes ativas nao permite alterar: ${alterados.join(', ')}.`);
      if (dto.status !== undefined && dto.status !== atual.status
        && (dto.status === CompeticaoLigaStatus.RASCUNHO || dto.status === CompeticaoLigaStatus.CANCELADA)) {
        throw new ConflictException('Competicao com inscricoes ativas nao pode ser movida para RASCUNHO ou CANCELADA.');
      }
    }
    this.validarTransicaoStatus(atual.status, estado.status as CompeticaoLigaStatus);
    const { id: _id, criadoEm: _criadoEm, atualizadoEm: _atualizadoEm, ...data } = estado as typeof atual;
    void _id; void _criadoEm; void _atualizadoEm;
    try {
      return mapear(await this.prisma.competicaoLiga.update({ where: { id }, data, select: adminCompeticaoSelect }));
    } catch (error) { this.tratarErroPrisma(error); }
  }

  private async criarEstado(client: EscritaCompeticaoClient, estado: EstadoCompeticao): Promise<Record<string, unknown>> {
    await this.validarLigaModalidade(client, estado.ligaModalidadeId);
    validarEstado(estado);
    return mapear(await client.competicaoLiga.create({ data: estado, select: adminCompeticaoSelect }));
  }

  private async validarLigaModalidade(client: EscritaCompeticaoClient, id: number): Promise<void> {
    const vinculo = await client.ligaModalidade.findUnique({ where: { id }, select: { ativa: true } });
    if (!vinculo) throw new NotFoundException('Vinculo liga/modalidade nao encontrado.');
    if (!vinculo.ativa) throw new BadRequestException('Vinculo liga/modalidade esta inativo.');
  }

  private validarTransicaoStatus(atual: CompeticaoLigaStatus, proximo: CompeticaoLigaStatus): void {
    if (atual === proximo) return;
    if (atual === CompeticaoLigaStatus.CANCELADA) {
      throw new ConflictException('Competicao CANCELADA nao pode voltar a um estado operacional.');
    }
    if (atual === CompeticaoLigaStatus.ENCERRADA && proximo === CompeticaoLigaStatus.INSCRICOES_ABERTAS) {
      throw new ConflictException('Competicao ENCERRADA nao pode reabrir inscricoes.');
    }
  }

  private mesmoValor(atual: unknown, novo: unknown): boolean {
    if (atual instanceof Date && novo instanceof Date) return atual.getTime() === novo.getTime();
    if (Prisma.Decimal.isDecimal(atual)) return atual.equals(novo as Prisma.Decimal.Value);
    return atual === novo;
  }

  private tratarErroPrisma(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Slug de competicao ja cadastrado.');
    }
    throw error;
  }
}
