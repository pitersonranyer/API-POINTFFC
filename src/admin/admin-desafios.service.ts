import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DesafioStatus, DesafioTipoAcesso, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminDesafioPartidasService } from './admin-desafio-partidas.service';
import { AtualizarAdminDesafioDto, CriarAdminDesafioDto, ListarAdminDesafiosQueryDto } from './dto/admin-desafios.dto';
import { periodoDasPartidas, statusDoDesafio } from '../desafios/desafio-periodo';

const desafioSelect = {
  id: true, nome: true, descricao: true, tipoAcesso: true, valorInscricao: true, status: true,
  inicioInscricao: true, fimInscricao: true, dataInicio: true, dataFim: true,
  limiteParticipantes: true, criadoPorId: true, publicadoEm: true, criadoEm: true, atualizadoEm: true,
  criadoPor: { select: { idUsuario: true, nome: true } },
} satisfies Prisma.DesafioSelect;

type DesafioRow = Prisma.DesafioGetPayload<{ select: typeof desafioSelect }>;
type Configuracao = Pick<DesafioRow, 'nome' | 'descricao' | 'tipoAcesso' | 'valorInscricao'
  | 'inicioInscricao' | 'fimInscricao' | 'dataInicio' | 'dataFim' | 'limiteParticipantes'>;

function mapear(row: DesafioRow): Record<string, unknown> {
  return {
    ...row, status: statusDoDesafio(row), valorInscricao: row.valorInscricao.toFixed(2),
    inicioInscricao: row.inicioInscricao.toISOString(), fimInscricao: row.fimInscricao.toISOString(),
    dataInicio: row.dataInicio.toISOString(), dataFim: row.dataFim.toISOString(),
    publicadoEm: row.publicadoEm?.toISOString() ?? null,
    criadoEm: row.criadoEm.toISOString(), atualizadoEm: row.atualizadoEm.toISOString(),
  };
}

function preparar(dto: AtualizarAdminDesafioDto): Partial<Configuracao> {
  const data: Partial<Configuracao> = {};
  if (dto.nome !== undefined) data.nome = dto.nome;
  if (dto.descricao !== undefined) data.descricao = dto.descricao;
  if (dto.tipoAcesso !== undefined) data.tipoAcesso = dto.tipoAcesso;
  if (dto.limiteParticipantes !== undefined) data.limiteParticipantes = dto.limiteParticipantes;
  if (dto.valorInscricao !== undefined) {
    if (typeof dto.valorInscricao !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(dto.valorInscricao)) {
      throw new BadRequestException('valorInscricao deve ser texto decimal com ate duas casas.');
    }
    data.valorInscricao = new Prisma.Decimal(dto.valorInscricao);
  }
  for (const campo of ['inicioInscricao', 'fimInscricao', 'dataInicio', 'dataFim'] as const) {
    if (dto[campo] !== undefined) {
      if (typeof dto[campo] !== 'string') throw new BadRequestException(`${campo} deve ser uma data valida.`);
      data[campo] = new Date(dto[campo]);
    }
  }
  return data;
}

function validar(estado: Configuracao, validarDatas = true): void {
  if (typeof estado.nome !== 'string' || !estado.nome.trim() || estado.nome.length > 255) {
    throw new BadRequestException('Nome obrigatorio, com ate 255 caracteres.');
  }
  if (!Object.values(DesafioTipoAcesso).includes(estado.tipoAcesso)) {
    throw new BadRequestException('Tipo de acesso invalido.');
  }
  const valor = estado.valorInscricao;
  if (!Prisma.Decimal.isDecimal(valor) || !valor.isFinite() || valor.lt(0)
    || valor.gt('9999999999.99') || valor.decimalPlaces() > 2) {
    throw new BadRequestException('Valor da inscricao invalido.');
  }
  if (estado.tipoAcesso === DesafioTipoAcesso.FREE && !valor.isZero()) {
    throw new BadRequestException('Desafio FREE deve ter valorInscricao igual a zero.');
  }
  if (estado.tipoAcesso === DesafioTipoAcesso.PAGO && !valor.gt(0)) {
    throw new BadRequestException('Desafio PAGO deve ter valorInscricao maior que zero.');
  }
  const { inicioInscricao, fimInscricao, dataInicio, dataFim, limiteParticipantes } = estado;
  if (validarDatas && [inicioInscricao, fimInscricao, dataInicio, dataFim].some(data => !(data instanceof Date) || !Number.isFinite(data.getTime()))) {
    throw new BadRequestException('Datas obrigatorias e validas.');
  }
  if (validarDatas && inicioInscricao >= fimInscricao) throw new BadRequestException('inicioInscricao deve ser anterior a fimInscricao.');
  if (validarDatas && fimInscricao > dataInicio) throw new BadRequestException('fimInscricao nao pode ser posterior a dataInicio.');
  if (validarDatas && dataInicio >= dataFim) throw new BadRequestException('dataInicio deve ser anterior a dataFim.');
  if (limiteParticipantes !== null && (!Number.isInteger(limiteParticipantes)
    || limiteParticipantes <= 0 || limiteParticipantes > 4294967295)) {
    throw new BadRequestException('limiteParticipantes deve ser inteiro positivo ou null.');
  }
}

@Injectable()
export class AdminDesafiosService {
  constructor(private readonly prisma: PrismaService, private readonly partidas: AdminDesafioPartidasService) {}

  async criar(usuarioId: number, dto: CriarAdminDesafioDto): Promise<Record<string, unknown>> {
    const estado = { descricao: null, limiteParticipantes: null, ...periodoDasPartidas([]), ...preparar(dto) } as Configuracao;
    validar(estado);
    return mapear(await this.prisma.desafio.create({
      data: { ...estado, criadoPorId: usuarioId, status: DesafioStatus.RASCUNHO, publicadoEm: null },
      select: desafioSelect,
    }));
  }

  async listar(query: ListarAdminDesafiosQueryDto): Promise<Record<string, unknown>> {
    const agora = new Date();
    const status: Prisma.DesafioWhereInput = query.status === 'ABERTO'
      ? { status: 'ABERTO', dataInicio: { gt: agora } }
      : query.status === 'EM_ANDAMENTO'
        ? { OR: [{ status: 'EM_ANDAMENTO' }, { status: 'ABERTO', dataInicio: { lte: agora } }] }
        : query.status !== undefined ? { status: query.status } : {};
    const where: Prisma.DesafioWhereInput = {
      ...status,
      ...(query.tipoAcesso !== undefined ? { tipoAcesso: query.tipoAcesso } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.desafio.count({ where }),
      this.prisma.desafio.findMany({ where, select: desafioSelect,
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        skip: (query.pagina - 1) * query.limite, take: query.limite }),
    ]);
    return { itens: rows.map(mapear), paginacao: {
      pagina: query.pagina, limite: query.limite, total, totalPaginas: Math.ceil(total / query.limite),
    } };
  }

  async buscar(id: number): Promise<Record<string, unknown>> {
    const row = await this.prisma.desafio.findUnique({ where: { id }, select: desafioSelect });
    if (!row) throw new NotFoundException('Desafio nao encontrado.');
    return mapear(row);
  }

  atualizar(id: number, dto: AtualizarAdminDesafioDto): Promise<Record<string, unknown>> {
    return this.alterarComBloqueio(id, async (atual, tx) => {
      this.exigirRascunho(atual);
      const data = preparar(dto);
      if (['inicioInscricao', 'fimInscricao', 'dataInicio', 'dataFim'].some(campo => campo in data)) {
        Object.assign(data, await this.partidas.recalcularPeriodo(tx, id));
      }
      validar({ ...atual, ...data });
      return data;
    });
  }

  async publicar(id: number): Promise<Record<string, unknown>> {
    const inicial = await this.prisma.desafio.findUnique({ where: { id }, select: desafioSelect });
    if (!inicial) throw new NotFoundException('Desafio nao encontrado.');
    this.exigirRascunho(inicial);
    validar(inicial, false);
    // Consultas externas fora do lock; o estado atual e a composicao serao conferidos sob lock.
    const preparacao = await this.partidas.prepararPublicacao(id);
    return this.alterarComBloqueio(id, async (atual, tx) => {
      this.exigirRascunho(atual);
      validar(atual, false);
      const periodo = await this.partidas.aplicarPublicacao(tx, atual, preparacao);
      const publicadoEm = new Date();
      if (periodo.dataInicio <= publicadoEm) throw new ConflictException('Primeira partida ja iniciou.');
      return { ...periodo, inicioInscricao: publicadoEm, status: DesafioStatus.ABERTO, publicadoEm };
    });
  }

  cancelar(id: number): Promise<Record<string, unknown>> {
    return this.alterarComBloqueio(id, atual => {
      const status = statusDoDesafio(atual);
      if (status !== DesafioStatus.RASCUNHO && status !== DesafioStatus.ABERTO) {
        throw new ConflictException('Somente desafios RASCUNHO ou ABERTO podem ser cancelados.');
      }
      return { status: DesafioStatus.CANCELADO };
    });
  }

  private exigirRascunho(atual: DesafioRow): void {
    if (atual.status !== DesafioStatus.RASCUNHO) throw new ConflictException('Operacao permitida somente em RASCUNHO.');
  }

  private alterarComBloqueio(id: number, prepararAlteracao: (atual: DesafioRow, tx: Prisma.TransactionClient) => Prisma.DesafioUpdateInput | Promise<Prisma.DesafioUpdateInput>): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async tx => {
      // Serializa PATCH, publicacao e cancelamento antes de ler/validar o estado final.
      const lock = await tx.$queryRaw<Array<{ ID: number | bigint }>>`
        SELECT ID FROM DESAFIO WHERE ID = ${id} FOR UPDATE`;
      if (!lock.length) throw new NotFoundException('Desafio nao encontrado.');
      const atual = await tx.desafio.findUnique({ where: { id }, select: desafioSelect });
      if (!atual) throw new NotFoundException('Desafio nao encontrado.');
      const data = await prepararAlteracao(atual, tx);
      const salvo = await tx.desafio.update({ where: { id }, data, select: desafioSelect });
      // Uma escrita lenta que atravesse o kickoff tambem deve desfazer a publicacao.
      if (data.publicadoEm && salvo.dataInicio <= new Date()) throw new ConflictException('Primeira partida ja iniciou.');
      return mapear(salvo);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
