import { Pool } from 'pg';

export const createSystemPool = (connectionString: string) => new Pool({ connectionString });
