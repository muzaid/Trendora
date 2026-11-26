import { conflict, invalid, notFound, type ProductDto, type StoreDto, type VariantDto } from '@trendora/contracts';
import { pgCode, PG_UNIQUE_VIOLATION } from '@trendora/db';
import type { Actor, Q, ServiceContext } from '../context';
import { audit } from '../ops';
import { requireActor, requireOrgPermission, requireStoreMember, requireStorePermission } from './identity';

export async function onboardMerchant(
  ctx: ServiceContext,
  actor: Actor | null,
  input: { organizationName: string; legalName: string; country: string; store: { name: string; slug: string; description: string; currency: string; country: string; shippingPolicy: string; returnPolicy: string } },
) {
  const a = requireActor(actor);
  try {
    return await ctx.db.tx(async (q) => {
      const org = await q.one<{ id: string }>(
        `insert into organizations (name, legal_name, country) values ($1,$2,$3) returning id`,
        [input.organizationName, input.legalName, input.country],
      );
      await q.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'OWNER')`, [org.id, a.userId]);
      const s = input.store;
      const store = await q.one<{ id: string }>(
        `insert into stores (org_id, slug, name, description, currency, country, shipping_policy, return_policy, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') returning id`,
        [org.id, s.slug, s.name, s.description, s.currency, s.country, s.shippingPolicy, s.returnPolicy],
      );
      await audit(q, { actorId: a.userId, action: 'merchant.onboarded', targetType: 'organization', targetId: org.id, metadata: { storeId: store.id } });
      return { orgId: org.id, storeId: store.id, verificationStatus: 'PENDING' };
    });
  } catch (e) {
    if (pgCode(e) === PG_UNIQUE_VIOLATION) throw conflict('That store URL is already taken');
    throw e;
  }
}

export async function addStaff(ctx: ServiceContext, actor: Actor | null, orgId: string, input: { userHandle: string; role: string }) {
  const a = requireOrgPermission(actor, orgId, 'staff.manage');
  if (input.role === 'OWNER') throw invalid('Ownership transfer requires platform support');
  const user = await ctx.db.maybeOne<{ id: string }>(`select id from profiles where handle = $1`, [input.userHandle]);
  if (!user) throw notFound('User');
  await ctx.db.tx(async (q) => {
    await q.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,$3) on conflict (org_id, user_id) do update set role = excluded.role`,
      [orgId, user.id, input.role],
    );
    await audit(q, { actorId: a.userId, action: 'staff.role_set', targetType: 'organization', targetId: orgId, metadata: { userId: user.id, role: input.role } });
  });
  return { ok: true };
}

export async function listStaff(ctx: ServiceContext, actor: Actor | null, orgId: string) {
  requireOrgPermission(actor, orgId, 'staff.manage');
  return ctx.db.query(`select p.handle, p.display_name as "displayName", m.role from memberships m join profiles p on p.id = m.user_id where m.org_id = $1 order by m.created_at`, [orgId]);
}

interface VariantIn { sku: string; title: string; priceMinor: number; stock: number; attributes: Record<string, string> }

async function insertVariant(q: Q, productId: string, currency: string, v: VariantIn, actorId: string) {
  const row = await q.one<{ id: string }>(
    `insert into variants (product_id, sku, title, price_minor, currency, attributes) values ($1,$2,$3,$4,$5,$6) returning id`,
    [productId, v.sku, v.title, v.priceMinor, currency, JSON.stringify(v.attributes)],
  );
  await q.query(`insert into inventory (variant_id, available) values ($1,$2)`, [row.id, v.stock]);
  await q.query(`insert into price_history (variant_id, price_minor, currency, changed_by) values ($1,$2,$3,$4)`, [row.id, v.priceMinor, currency, actorId]);
  return row.id;
}

export async function createProduct(
  ctx: ServiceContext,
  actor: Actor | null,
  input: { storeId: string; title: string; description: string; imageUrls: string[]; status: 'DRAFT' | 'ACTIVE'; variants: VariantIn[] },
) {
  const { actor: a, store } = await requireStorePermission(ctx.db, actor, input.storeId, 'catalog.write');
  const skus = new Set(input.variants.map((v) => v.sku));
  if (skus.size !== input.variants.length) throw invalid('SKUs must be unique within a product');
  try {
    return await ctx.db.tx(async (q) => {
      const p = await q.one<{ id: string }>(
        `insert into products (store_id, title, description, image_urls, status) values ($1,$2,$3,$4,$5) returning id`,
        [input.storeId, input.title, input.description, JSON.stringify(input.imageUrls), input.status],
      );
      const variantIds: string[] = [];
      for (const v of input.variants) variantIds.push(await insertVariant(q, p.id, store.currency, v, a.userId));
      await audit(q, { actorId: a.userId, action: 'product.created', targetType: 'product', targetId: p.id });
      return { productId: p.id, variantIds };
    });
  } catch (e) {
    if (pgCode(e) === PG_UNIQUE_VIOLATION) throw conflict('Duplicate SKU');
    throw e;
  }
}

export async function setProductStatus(ctx: ServiceContext, actor: Actor | null, productId: string, status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED') {
  const p = await ctx.db.maybeOne<{ store_id: string }>(`select store_id from products where id = $1 and deleted_at is null`, [productId]);
  if (!p) throw notFound('Product');
  const { actor: a } = await requireStorePermission(ctx.db, actor, p.store_id, 'catalog.write');
  await ctx.db.tx(async (q) => {
    await q.query(`update products set status = $2, deleted_at = case when $2 = 'ARCHIVED' then now() else null end where id = $1`, [productId, status]);
    await audit(q, { actorId: a.userId, action: 'product.status', targetType: 'product', targetId: productId, metadata: { status } });
  });
  return { ok: true };
}

async function variantStore(q: Q, variantId: string) {
  const v = await q.maybeOne<{ store_id: string; currency: string }>(
    `select p.store_id, v.currency from variants v join products p on p.id = v.product_id where v.id = $1`,
    [variantId],
  );
  if (!v) throw notFound('Variant');
  return v;
}

export async function updatePrice(ctx: ServiceContext, actor: Actor | null, variantId: string, priceMinor: number) {
  const v = await variantStore(ctx.db, variantId);
  const { actor: a } = await requireStorePermission(ctx.db, actor, v.store_id, 'catalog.write');
  await ctx.db.tx(async (q) => {
    await q.query(`update variants set price_minor = $2 where id = $1`, [variantId, priceMinor]);
    await q.query(`insert into price_history (variant_id, price_minor, currency, changed_by) values ($1,$2,$3,$4)`, [variantId, priceMinor, v.currency, a.userId]);
    await audit(q, { actorId: a.userId, action: 'variant.price', targetType: 'variant', targetId: variantId, metadata: { priceMinor } });
  });
  return { ok: true };
}

/** Optimistic-concurrency inventory adjustment; never lets available go negative (DB check). */
export async function adjustInventory(ctx: ServiceContext, actor: Actor | null, variantId: string, delta: number, expectedVersion: number) {
  const v = await variantStore(ctx.db, variantId);
  const { actor: a } = await requireStorePermission(ctx.db, actor, v.store_id, 'catalog.write');
  return ctx.db.tx(async (q) => {
    const row = await q.maybeOne<{ available: number; version: number }>(
      `update inventory set available = available + $2, version = version + 1, updated_at = now()
       where variant_id = $1 and version = $3 and available + $2 >= 0 returning available, version`,
      [variantId, delta, expectedVersion],
    );
    if (!row) throw conflict('Inventory changed or would go negative; reload and retry');
    await audit(q, { actorId: a.userId, action: 'inventory.adjust', targetType: 'variant', targetId: variantId, metadata: { delta } });
    return row;
  });
}

/** CSV import: title,description,sku,variant_title,price_minor,stock[,image_url]. Rows with the same title share a product. */
export function parseCatalogCsv(csv: string) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift()?.split(',').map((h) => h.trim().toLowerCase());
  const required = ['title', 'description', 'sku', 'variant_title', 'price_minor', 'stock'];
  if (!header || !required.every((h) => header.includes(h))) throw invalid(`CSV header must include: ${required.join(', ')}`);
  const idx = (k: string) => header.indexOf(k);
  const products = new Map<string, { title: string; description: string; imageUrls: string[]; variants: VariantIn[] }>();
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const cells = splitCsvLine(line);
    const get = (k: string) => (idx(k) >= 0 ? (cells[idx(k)] ?? '').trim() : '');
    const price = Number(get('price_minor'));
    const stock = Number(get('stock'));
    if (!get('title') || !get('sku') || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(stock) || stock < 0) {
      errors.push(`row ${i + 2}: invalid values`);
      return;
    }
    const p = products.get(get('title')) ?? { title: get('title'), description: get('description'), imageUrls: [], variants: [] };
    const img = get('image_url');
    if (img && /^https:\/\//.test(img) && !p.imageUrls.includes(img)) p.imageUrls.push(img);
    p.variants.push({ sku: get('sku'), title: get('variant_title') || 'Default', priceMinor: price, stock, attributes: {} });
    products.set(p.title, p);
  });
  return { products: [...products.values()], errors };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export async function importCsv(ctx: ServiceContext, actor: Actor | null, storeId: string, csv: string) {
  const { products, errors } = parseCatalogCsv(csv);
  if (errors.length) throw invalid('CSV contains invalid rows', { errors });
  const created: string[] = [];
  for (const p of products) {
    const r = await createProduct(ctx, actor, { storeId, title: p.title, description: p.description, imageUrls: p.imageUrls, status: 'ACTIVE', variants: p.variants });
    created.push(r.productId);
  }
  return { created: created.length, productIds: created };
}

type VariantRow = { id: string; product_id: string; sku: string; title: string; price_minor: number; currency: string; attributes: Record<string, string>; available: number; reserved: number; version: number };

async function variantsFor(q: Q, productIds: string[], includeStock: boolean): Promise<Map<string, VariantDto[]>> {
  const rows = productIds.length
    ? await q.query<VariantRow>(
        `select v.id, v.product_id, v.sku, v.title, v.price_minor, v.currency, v.attributes, coalesce(i.available,0) as available, coalesce(i.reserved,0) as reserved, coalesce(i.version,0) as version
         from variants v left join inventory i on i.variant_id = v.id where v.product_id = any($1) and v.status = 'ACTIVE' order by v.created_at`,
        [productIds],
      )
    : [];
  const map = new Map<string, VariantDto[]>();
  for (const r of rows) {
    const dto: VariantDto & { reserved?: number; version?: number } = { id: r.id, sku: r.sku, title: r.title, priceMinor: r.price_minor, currency: r.currency, attributes: r.attributes, inStock: r.available > 0 };
    if (includeStock) Object.assign(dto, { available: r.available, reserved: r.reserved, version: r.version });
    map.set(r.product_id, [...(map.get(r.product_id) ?? []), dto]);
  }
  return map;
}

async function offersFor(q: Q, productIds: string[]) {
  if (!productIds.length) return [];
  return q.query<{ campaign_id: string; variant_id: string; offer_minor: number; required_qty: number; product_id: string }>(
    `select cs.campaign_id, cs.variant_id, cs.offer_minor, cs.required_qty, v.product_id
     from campaign_skus cs join variants v on v.id = cs.variant_id join campaigns c on c.id = cs.campaign_id
     where v.product_id = any($1) and c.status = 'OPEN' and not c.frozen`,
    [productIds],
  );
}

/** Public store page (GET /v1/stores/:slug) — reads only approved public rows. */
export async function publicStore(ctx: ServiceContext, slug: string): Promise<StoreDto> {
  const s = await ctx.db.maybeOne<{ id: string; slug: string; name: string; description: string; currency: string; country: string; shipping_policy: string; return_policy: string }>(
    `select id, slug, name, description, currency, country, shipping_policy, return_policy from app_public.stores where slug = $1`,
    [slug],
  );
  if (!s) throw notFound('Store');
  const products = await ctx.db.query<{ id: string; store_id: string; title: string; description: string; image_urls: string[] }>(
    `select id, store_id, title, description, image_urls from app_public.products where store_id = $1 order by title`,
    [s.id],
  );
  const ids = products.map((p) => p.id);
  const variants = await variantsFor(ctx.db, ids, false);
  const offers = await offersFor(ctx.db, ids);
  const campaigns = await ctx.db.query<{ id: string; title: string; tagline: string; status: string; store_id: string; starts_at: Date; submission_end: Date; vote_end: Date; currency: string }>(
    `select id, title, tagline, status, store_id, starts_at, submission_end, vote_end, currency from app_public.campaigns
     where store_id = $1 and status in ('SCHEDULED','OPEN','SUBMISSION_CLOSED','VOTING_CLOSED','REVIEWING','FINALIZED') order by starts_at desc`,
    [s.id],
  );
  return {
    id: s.id, slug: s.slug, name: s.name, description: s.description, currency: s.currency, country: s.country,
    shippingPolicy: s.shipping_policy, returnPolicy: s.return_policy,
    products: products.map((p) => ({
      id: p.id, storeId: p.store_id, title: p.title, description: p.description, imageUrls: p.image_urls,
      variants: variants.get(p.id) ?? [],
      campaignOffers: offers.filter((o) => o.product_id === p.id).map((o) => ({ campaignId: o.campaign_id, variantId: o.variant_id, offerMinor: o.offer_minor, requiredQty: o.required_qty })),
    })),
    activeCampaigns: campaigns.map((c) => ({ id: c.id, title: c.title, tagline: c.tagline, status: c.status as never, storeId: c.store_id, startsAt: new Date(c.starts_at).toISOString(), submissionEnd: new Date(c.submission_end).toISOString(), voteEnd: new Date(c.vote_end).toISOString(), currency: c.currency })),
  };
}

export async function publicProduct(ctx: ServiceContext, productId: string): Promise<ProductDto & { store: { slug: string; name: string; shippingPolicy: string; returnPolicy: string }; relatedEntries: { entryId: string; creatorHandle: string; caption: string; posterUrl: string | null }[]; priceHistory: { priceMinor: number; at: string }[] }> {
  const p = await ctx.db.maybeOne<{ id: string; store_id: string; title: string; description: string; image_urls: string[]; slug: string; name: string; shipping_policy: string; return_policy: string }>(
    `select p.id, p.store_id, p.title, p.description, p.image_urls, s.slug, s.name, s.shipping_policy, s.return_policy
     from app_public.products p join app_public.stores s on s.id = p.store_id where p.id = $1`,
    [productId],
  );
  if (!p) throw notFound('Product');
  const variants = await variantsFor(ctx.db, [p.id], false);
  const offers = await offersFor(ctx.db, [p.id]);
  const related = await ctx.db.query<{ entry_id: string; creator_handle: string; caption: string; poster_url: string | null }>(
    `select f.entry_id, f.creator_handle, f.caption, f.poster_url from app_public.feed f
     where f.campaign_id in (select cs.campaign_id from campaign_skus cs join variants v on v.id = cs.variant_id where v.product_id = $1)
     order by f.approved_at desc limit 6`,
    [p.id],
  );
  const history = await ctx.db.query<{ price_minor: number; created_at: Date }>(
    `select ph.price_minor, ph.created_at from price_history ph join variants v on v.id = ph.variant_id where v.product_id = $1 order by ph.created_at desc limit 10`,
    [p.id],
  );
  return {
    id: p.id, storeId: p.store_id, title: p.title, description: p.description, imageUrls: p.image_urls,
    variants: variants.get(p.id) ?? [],
    campaignOffers: offers.map((o) => ({ campaignId: o.campaign_id, variantId: o.variant_id, offerMinor: o.offer_minor, requiredQty: o.required_qty })),
    store: { slug: p.slug, name: p.name, shippingPolicy: p.shipping_policy, returnPolicy: p.return_policy },
    relatedEntries: related.map((r) => ({ entryId: r.entry_id, creatorHandle: r.creator_handle, caption: r.caption, posterUrl: r.poster_url })),
    priceHistory: history.map((h) => ({ priceMinor: h.price_minor, at: new Date(h.created_at).toISOString() })),
  };
}

/** Merchant catalog with stock levels (merchant console). */
export async function merchantCatalog(ctx: ServiceContext, actor: Actor | null, storeId: string) {
  await requireStoreMember(ctx.db, actor, storeId);
  const products = await ctx.db.query<{ id: string; title: string; description: string; status: string; image_urls: string[] }>(
    `select id, title, description, status, image_urls from products where store_id = $1 and deleted_at is null order by created_at`,
    [storeId],
  );
  const variants = await variantsFor(ctx.db, products.map((p) => p.id), true);
  return products.map((p) => ({ id: p.id, title: p.title, description: p.description, status: p.status, imageUrls: p.image_urls, variants: variants.get(p.id) ?? [] }));
}

export async function merchantContext(ctx: ServiceContext, actor: Actor | null) {
  const a = requireActor(actor);
  if (a.memberships.length === 0) return { organizations: [] };
  const orgs = await ctx.db.query<{ id: string; name: string; verification_status: string }>(
    `select id, name, verification_status from organizations where id = any($1) order by name`,
    [a.memberships.map((m) => m.orgId)],
  );
  const stores = await ctx.db.query<{ id: string; org_id: string; slug: string; name: string; currency: string; status: string }>(
    `select id, org_id, slug, name, currency, status from stores where org_id = any($1) and deleted_at is null order by name`,
    [orgs.map((o) => o.id)],
  );
  return {
    organizations: orgs.map((o) => ({
      id: o.id, name: o.name, verificationStatus: o.verification_status,
      role: a.memberships.find((m) => m.orgId === o.id)!.role,
      stores: stores.filter((s) => s.org_id === o.id).map((s) => ({ id: s.id, slug: s.slug, name: s.name, currency: s.currency, status: s.status })),
    })),
  };
}
