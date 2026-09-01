import { environmentValidationSchema } from '../src/config/environment.validation';

const validEnvironment = {
  FRONTEND_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://user:password@localhost:3306/database',
  ROOT_EMAIL: 'root@example.com',
  JWT_SECRET: '12345678901234567890123456789012',
  FIREBASE_PROJECT_ID: 'project',
  FIREBASE_CLIENT_EMAIL: 'firebase@example.com',
  FIREBASE_PRIVATE_KEY: 'private-key',
};

describe('environmentValidationSchema Redis', () => {
  it('aceita fallback local sem REDIS_URL em desenvolvimento', () => {
    const result = environmentValidationSchema.validate({ ...validEnvironment, NODE_ENV: 'development', REDIS_URL: '' });
    expect(result.error).toBeUndefined();
  });

  it('exige REDIS_URL válida em produção', () => {
    const missing = environmentValidationSchema.validate({ ...validEnvironment, NODE_ENV: 'production' });
    const valid = environmentValidationSchema.validate({ ...validEnvironment, NODE_ENV: 'production', REDIS_URL: 'redis://localhost:6379' });
    expect(missing.error?.message).toContain('REDIS_URL');
    expect(valid.error).toBeUndefined();
  });
});
