import { migrate } from '../migrate';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await migrate(url, { localAuthStub: process.env.LOCAL_AUTH_STUB === '1', log: console.log });
console.log('migrations up to date');
