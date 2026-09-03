import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { execFileSync } from 'node:child_process';
import { AppModule } from './app.module';

function applyPendingMigrations(): void {
  const prismaCli = require.resolve('prisma/build/index.js');

  console.log('Verificando migrations pendentes do banco de dados...');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
}

async function bootstrap(): Promise<void> {
  applyPendingMigrations();
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({
    origin: config.getOrThrow<string>('FRONTEND_URL'),
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Api-Pointffc')
    .setDescription('Autenticação e cadastro de usuários')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  await app.listen(config.get<number>('PORT', 3001));
}

void bootstrap();
