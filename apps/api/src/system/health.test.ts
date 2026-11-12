import 'reflect-metadata';
import { Controller, Get, HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ErrorBodySchema } from '@sdlc/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../common/api-exception';
import { configureApp } from '../setup';
import { SystemModule } from './system.module';

@Controller('test')
class ThrowingController {
  @Get('validation')
  validation(): never {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_error', 'Bad input', { name: 'required' });
  }
  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail');
  }
}

describe('API foundation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SystemModule],
      controllers: [ThrowingController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => app.close());

  it('GET /health returns { ok: true } without auth', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('unknown routes use the shared error format', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(ErrorBodySchema.parse(res.body).error).toBe('not_found');
  });

  it('ApiException carries code, message and fields', async () => {
    const res = await request(app.getHttpServer()).get('/test/validation').expect(400);
    expect(res.body).toEqual({ error: 'validation_error', message: 'Bad input', fields: { name: 'required' } });
  });

  it('unexpected errors become internal_error without leaking details', async () => {
    const res = await request(app.getHttpServer()).get('/test/boom').expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Internal server error' });
  });
});
