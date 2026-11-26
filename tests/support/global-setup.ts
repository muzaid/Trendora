import pg from 'pg';
import { migrate } from '@trendora/db';

/**
 * Builds a migrated template database once; each test file clones it
 * (CREATE DATABASE ... TEMPLATE) for full isolation.
 */
export const templateDb = () => process.env.TRENDORA_TEMPLATE_DB ?? 'trendora_test_template';

export function adminUrl() {
  return process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
}

export async function buildTemplate(name: string) {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  await migrate(url.toString(), { localAuthStub: true });
}

export default async function setup() {
  await buildTemplate(templateDb());
}
