// Independent process, synthetic HTTP only. No CLI entry in package.json.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Prisma, PrismaClient } = require('@prisma/client');
const { isolatedUrl } = require('../../scripts/point-fantasy-scoring-backfill.cjs');
const root = path.resolve(__dirname, '../..');
let release;
process.on('message', async request => {
  if (request === 'release') { release?.(); return; }
  let db;
  try {
    const url = isolatedUrl(process.env.POINT_FANTASY_ADMISSION_TEST_URL);
    db = new PrismaClient({ datasources: { db: { url } }, log: [] });
    const { WriterAdmissionService } = require('../../dist/point-fantasy/observation/writer-admission.service');
    if (request.action !== 'collect') {
      const admin = new WriterAdmissionService(db, url);
      const input = { ...request.input };
      for (const key of ['expectedGeneration','expectedRevision','expectedFence']) input[key] = BigInt(input[key]);
      const result = await admin[request.action](input);
      process.send({ done: true, result: JSON.parse(JSON.stringify(result, (_,v) => typeof v === 'bigint' ? v.toString() : v)) });
    } else {
      let calls = 0;
      const source = { get: async endpoint => {
        calls++;
        if (request.hold && endpoint === '/atletas/pontuados') {
          await new Promise(resolve => { release = resolve; process.send({ ready: true }); });
        }
        return { endpoint, status: 200, error: null, headers: {}, receivedAt: new Date().toISOString(),
          text: endpoint === '/mercado/status' ? JSON.stringify({ temporada: request.season, rodada_atual: request.round, status_mercado: 2 })
            : endpoint.startsWith('/partidas/') ? JSON.stringify({ rodada: request.round, partidas: [] })
              : `{"rodada":${request.round},"atletas":{"1":{"pontuacao":${request.points || '1.2'},"posicao_id":6}}}` };
      } };
      let client = db, failures = 0;
      if (request.failure) client = new Proxy(db, { get(target,key) {
        if (key === '$transaction') return (action,options) => target.$transaction(tx => action(new Proxy(tx, { get(t,k) {
          if (k === 'fantasyPontuacaoSnapshot' || k === 'fantasyPontuacaoAtleta') return new Proxy(Reflect.get(t,k), { get(model,method) {
            if (method !== 'create' && method !== 'createMany' && method !== 'updateMany') return Reflect.get(model,method);
            return async args => { const result = await model[method](args); if (++failures === 1) {
              if (request.failure === 'deadlock') throw new Prisma.PrismaClientKnownRequestError('fixture', { code: 'P2010', clientVersion: Prisma.prismaVersion.client, meta: { code: '1213' } });
              throw Error('fixture permanent failure');
            } return result; };
          } });
          return Reflect.get(t,k);
        } })),options);
        return Reflect.get(target,key);
      } });
      let Service;
      if (request.kind === 'OLD') {
        const filename = path.join(root, 'dist/point-fantasy/observation/pre-admission-fixture.cjs');
        const frozen = fs.readFileSync(process.env.POINT_FANTASY_PRE_ADMISSION_SOURCE, 'utf8');
        const compiled = require('typescript').transpileModule(frozen, { compilerOptions: { module: 1, target: 9, experimentalDecorators: true, emitDecoratorMetadata: true } }).outputText;
        const fixture = new Module(filename, module); fixture.filename = filename; fixture.paths = Module._nodeModulePaths(path.dirname(filename)); fixture._compile(compiled, filename);
        Service = fixture.exports.ObservationService;
      } else Service = require('../../dist/point-fantasy/observation/' + (request.kind === 'CURRENT' ? 'current-scoring.service' : 'observation.service'))[request.kind === 'CURRENT' ? 'CurrentScoringService' : 'ObservationService'];
      const service = request.kind === 'CURRENT' ? new Service(client, source, url, require('../../dist/point-fantasy/observation/current-scoring-policy').partialScoringPolicy) : new Service(client, source);
      const result = await service.collect(request.season, request.round, request.operationId);
      process.send({ done: true, result, calls });
    }
  } catch (error) { process.send({ done: true, error: error.code || 'WORKER_FAILED' }); }
  finally { if (db) await db.$disconnect(); if (process.connected) process.disconnect(); }
});
