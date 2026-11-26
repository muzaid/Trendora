import { migrate, resetDatabase } from '@trendora/db';
import { createServices } from '../container';
import { seed } from './seed';

const services = createServices();
const url = services.config.DATABASE_URL;
if (process.argv.includes('--reset')) {
  await resetDatabase(url);
}
await migrate(url, { localAuthStub: process.env.LOCAL_AUTH_STUB !== '0', log: console.log });
const existing = await services.db.maybeOne(`select 1 from stores where slug = 'glowlab'`);
if (existing) {
  console.log('seed: glowlab already exists (use --reset to recreate)');
} else {
  const t = Date.now();
  const r = await seed(services, (m) => console.log(`seed: ${m}`));
  console.log(`seed complete in ${((Date.now() - t) / 1000).toFixed(1)}s`, { store: r.storeSlug, liveCampaign: r.campaignId, pastCampaign: r.pastCampaignId });
}
await services.db.close();
