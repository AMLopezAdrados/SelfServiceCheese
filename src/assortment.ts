import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Catalogue, CatalogueProduct } from './pos.ts';

// Which POS categories and products the kiosk offers. The POS stays the
// source of products and prices; this only switches them off for the kiosk.
// Stored as a small JSON file on the kiosk server (KIOSK_DATA_DIR), so it
// survives restarts and never touches the POS.
//
// Everything is ON unless switched off here: a product newly added in the
// POS appears on the kiosk by itself.

export interface AssortmentData {
  disabledCategories: string[];
  disabledProducts: string[];
  updatedAt: string | null;
}

export interface AssortmentCategory {
  id: string;
  name: string;
  enabled: boolean;
  products: { id: string; name: string; price: number; enabled: boolean }[];
}

export class AssortmentStore {
  private data: AssortmentData = { disabledCategories: [], disabledProducts: [], updatedAt: null };

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AssortmentData>;
      this.data = {
        disabledCategories: Array.isArray(parsed.disabledCategories) ? parsed.disabledCategories.filter((x) => typeof x === 'string') : [],
        disabledProducts: Array.isArray(parsed.disabledProducts) ? parsed.disabledProducts.filter((x) => typeof x === 'string') : [],
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`assortment: cannot read ${file}: ${(err as Error).message}`);
    }
  }

  get(): AssortmentData {
    return this.data;
  }

  isAvailable(p: CatalogueProduct): boolean {
    return !this.data.disabledCategories.includes(p.category_id) && !this.data.disabledProducts.includes(p.id);
  }

  // The catalogue as the kiosk shows it.
  filter(c: Catalogue): Catalogue {
    return { ...c, products: c.products.filter((p) => this.isAvailable(p)) };
  }

  // Every POS category and product with its switch, for the staff panel.
  overview(c: Catalogue): AssortmentCategory[] {
    const cats = new Map<string, AssortmentCategory>();
    for (const p of c.products) {
      let cat = cats.get(p.category_id);
      if (!cat) {
        cat = { id: p.category_id, name: p.category, enabled: !this.data.disabledCategories.includes(p.category_id), products: [] };
        cats.set(p.category_id, cat);
      }
      cat.products.push({ id: p.id, name: p.name, price: p.price, enabled: !this.data.disabledProducts.includes(p.id) });
    }
    return [...cats.values()];
  }

  save(disabledCategories: string[], disabledProducts: string[]): AssortmentData {
    this.data = {
      disabledCategories: [...new Set(disabledCategories)],
      disabledProducts: [...new Set(disabledProducts)],
      updatedAt: new Date().toISOString(),
    };
    if (this.file) {
      // Write-then-rename: a crash mid-write never leaves a half file.
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    }
    return this.data;
  }
}
