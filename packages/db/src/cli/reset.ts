import '../load-env';
import { migrate, resetDatabase } from '../migrate';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await resetDatabase(url);
await migrate(url, { localAuthStub: true, log: console.log });
console.log('database reset');
