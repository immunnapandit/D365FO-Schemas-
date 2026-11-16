import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countForms, createForm } from '../repositories/forms.js';
import { logger } from '../logger.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed');

// Listed by name so that only these files are ever loaded.
const STARTER_FORMS = ['01-fno-sales-order.json', '02-fno-create-customer.json'];

/** Adds the starter forms on an empty database (only when SEED_SAMPLE_FORMS is on). */
export async function seedSampleForms() {
  if ((await countForms()) > 0) return 0;
  const files = STARTER_FORMS;
  for (const f of files) {
    // eslint-disable-next-line no-unused-vars
    const { id, ...def } = JSON.parse(await fs.readFile(path.join(SEED_DIR, f), 'utf8'));
    await createForm(def, { id: 'system', name: 'system' });
  }
  logger.info({ count: files.length }, 'starter forms added');
  return files.length;
}
