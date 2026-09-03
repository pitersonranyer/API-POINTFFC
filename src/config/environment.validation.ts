import * as Joi from 'joi';

export const environmentValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3001),
  FRONTEND_URL: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
  DATABASE_URL: Joi.string().uri({ scheme: ['mysql'] }).required(),
  ROOT_EMAIL: Joi.string().email().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().email().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
  CARTOLA_API_URL: Joi.string().uri({ scheme: ['https'] }).default('https://api.cartolafc.globo.com'),
  CARTOLA_API_TIMEOUT_MS: Joi.number().integer().min(1000).max(30000).default(5000),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).optional().allow(''),
  REDIS_SCORED_STALE_TTL_SECONDS: Joi.number().integer().min(60).default(86400),
  REDIS_LOCK_TTL_MS: Joi.number().integer().min(1000).max(60000).default(10000),
  REDIS_LOCK_WAIT_MS: Joi.number().integer().min(100).max(30000).default(5000),
});
