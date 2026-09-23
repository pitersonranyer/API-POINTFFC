import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('LoteInscricao - contrato persistente', () => {
  const model = (name: string) => Prisma.dmmf.datamodel.models.find(item => item.name === name)!;
  const field = (name: string, campo: string) => model(name).fields.find(item => item.name === campo)!;
  const sql = readFileSync(join(__dirname, '../prisma/migrations/0018_lote_inscricao/migration.sql'), 'utf8');

  it('preserva inscricoes historicas sem lote e nao exige vinculo com recarga', () => {
    expect(field('InscricaoTimeCompeticao', 'loteInscricaoId')).toMatchObject({ isRequired: false, hasDefaultValue: false });
    expect(field('InscricaoTimeCompeticao', 'loteInscricao')).toMatchObject({ isRequired: false, relationOnDelete: 'Restrict' });
    expect(model('LoteInscricao').fields.some(item => item.type === 'RecargaCarteira')).toBe(false);
    expect(sql).toMatch(/ADD COLUMN `LOTE_INSCRICAO_ID` INTEGER UNSIGNED NULL/);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE `)\b/i);
  });

  it('define chave unica por usuario, independente de competicao e requestHash', () => {
    expect(model('LoteInscricao').uniqueFields).toContainEqual(['usuarioId', 'chaveIdempotenciaHash']);
    expect(field('LoteInscricao', 'requestHash')).toMatchObject({ isRequired: true, isUnique: false });
    expect(sql).toContain('UNIQUE INDEX `LOTE_INSCRICAO_USUARIO_CHAVE_key` (`USUARIO_ID`, `CHAVE_IDEMPOTENCIA_HASH`)');
  });

  it('define um debito exclusivo por lote com FK restritiva e relacao 1:N de inscricoes', () => {
    expect(field('LoteInscricao', 'movimentacaoDebitoId')).toMatchObject({ isRequired: false, isUnique: true });
    expect(field('LoteInscricao', 'movimentacaoDebito')).toMatchObject({
      type: 'MovimentacaoCarteira', relationOnDelete: 'Restrict', relationFromFields: ['movimentacaoDebitoId'],
    });
    expect(field('LoteInscricao', 'inscricoes')).toMatchObject({ type: 'InscricaoTimeCompeticao', isList: true });
    expect(sql).toContain('UNIQUE INDEX `LOTE_INSCRICAO_DEBITO_key` (`MOVIMENTACAO_DEBITO_ID`)');
    expect(sql).toContain('REFERENCES `MOVIMENTACAO_CARTEIRA` (`id`) ON DELETE RESTRICT');
  });

  it('guarda snapshots monetarios e permite montar lote antes da confirmacao', () => {
    expect(field('LoteInscricao', 'valorUnitario').type).toBe('Decimal');
    expect(field('LoteInscricao', 'valorTotal').type).toBe('Decimal');
    expect(field('LoteInscricao', 'moeda').default).toBe('BRL');
    expect(field('LoteInscricao', 'respostaOriginal')).toMatchObject({ type: 'Json', isRequired: false });
    expect(field('LoteInscricao', 'confirmadoEm').isRequired).toBe(false);
    expect(sql).toContain("`TIPO_ACESSO` <> 'PAGO' OR `CONFIRMADO_EM` IS NULL OR `MOVIMENTACAO_DEBITO_ID` IS NOT NULL");
  });
});
