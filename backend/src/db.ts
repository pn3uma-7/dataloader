import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let pool: Pool;

interface RdsSecret {
  host: string;
  port?: number;
  dbname: string;
  username: string;
  password: string;
}

export async function initDb(): Promise<void> {
  const secretArn = process.env.RDS_SECRET_ARN;

  if (secretArn) {
    const smClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    const response = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const secret: RdsSecret = JSON.parse(response.SecretString!);
    pool = new Pool({
      host: secret.host,
      port: secret.port ?? 5432,
      database: secret.dbname,
      user: secret.username,
      password: secret.password,
      ssl: { rejectUnauthorized: false },
    });
  } else {
    // Local dev: configure via environment variables
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'dataloader',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      ssl: { rejectUnauthorized: false },
    });
  }

  await pool.query('SELECT 1');
  console.log('Connected to RDS PostgreSQL');
}

export function getPool(): Pool {
  return pool;
}
