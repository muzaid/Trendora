import { existsSync } from 'node:fs';

// Side-effect module: load the repo-root .env for CLIs when variables are not already
// set (CI and hosting platforms inject them directly). Import it first.
if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
