import 'reflect-metadata';
import { bootstrapConfig } from '../../config/env';
import { logger } from '../../shared/logger';
import { createDataSource } from './dataSource';
import { ProductOrmEntity } from './ProductOrmEntity';

/**
 * Inserts a small, deterministic sample catalogue.
 *
 * Deterministic on purpose: the rows include deliberate collisions - two
 * products at the same price, two with the same name prefix - so that a manual
 * poke at the API exercises the pagination tie-breaker rather than only the
 * happy path.
 *
 * Idempotent: re-running skips SKUs that already exist, so it is safe to run
 * against a database that has been seeded before.
 */
const SAMPLE_PRODUCTS: ReadonlyArray<Omit<ProductOrmEntity, 'id' | 'version' | 'createdAt' | 'updatedAt'>> = [
  { sku: 'BEV-COLA-330', name: 'Cola 330ml', description: 'Carbonated soft drink', category: 'beverage', priceMinor: 12_000, currency: 'VND', stock: 240, isActive: true },
  { sku: 'BEV-COLA-500', name: 'Cola 500ml', description: 'Carbonated soft drink', category: 'beverage', priceMinor: 18_000, currency: 'VND', stock: 120, isActive: true },
  { sku: 'BEV-TEA-GREEN', name: 'Green tea, unsweetened', description: null, category: 'beverage', priceMinor: 15_000, currency: 'VND', stock: 0, isActive: true },
  { sku: 'BEV-TEA-MILK', name: 'Milk tea', description: 'Contains dairy', category: 'beverage', priceMinor: 15_000, currency: 'VND', stock: 42, isActive: true },
  { sku: 'SNK-CHIPS-SALT', name: 'Potato chips, salted', description: null, category: 'snack', priceMinor: 22_000, currency: 'VND', stock: 88, isActive: true },
  { sku: 'SNK-CHIPS-BBQ', name: 'Potato chips, barbecue', description: null, category: 'snack', priceMinor: 22_000, currency: 'VND', stock: 0, isActive: false },
  { sku: 'HOU-SOAP-DISH', name: 'Dish soap 750ml', description: 'Lemon scented', category: 'household', priceMinor: 45_000, currency: 'VND', stock: 30, isActive: true },
  { sku: 'PER-SHAMPOO-400', name: 'Shampoo 400ml', description: null, category: 'personal_care', priceMinor: 95_000, currency: 'VND', stock: 17, isActive: true },
  { sku: 'ELE-CABLE-USBC', name: 'USB-C cable 1m', description: '60W charging', category: 'electronics', priceMinor: 120_000, currency: 'VND', stock: 55, isActive: true },
  { sku: 'ELE-POWERBANK-10K', name: 'Power bank 10000mAh', description: null, category: 'electronics', priceMinor: 450_000, currency: 'VND', stock: 8, isActive: true },
];

async function seed(): Promise<void> {
  const dataSource = createDataSource(bootstrapConfig());
  await dataSource.initialize();
  const repository = dataSource.getRepository(ProductOrmEntity);

  let inserted = 0;
  for (const product of SAMPLE_PRODUCTS) {
    const existing = await repository.findOne({ where: { sku: product.sku } });
    if (existing !== null) {
      continue;
    }
    await repository.save(repository.create(product));
    inserted += 1;
  }

  logger.info({ inserted, skipped: SAMPLE_PRODUCTS.length - inserted }, 'seed complete');
  await dataSource.destroy();
}

seed().catch((error: unknown) => {
  logger.fatal({ err: error }, 'seed failed');
  process.exit(1);
});
