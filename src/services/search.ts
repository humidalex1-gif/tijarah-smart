import { prisma } from "@/lib/db";

/**
 * One box over the two things the owner actually looks for: a product, by
 * code or by either name, and an order, by its number.
 *
 * Read-only by construction, and bounded: each section is capped, and a blank
 * query returns nothing rather than everything — an uncapped blank search is
 * a very slow list page wearing a search box.
 *
 * Case: Prisma's `contains` compiles to SQLite's LIKE, which is already
 * case-insensitive for ASCII — which is exactly the SKU alphabet — and Arabic
 * has no case at all. So no raw SQL and no second lowercase column.
 */
export interface SearchResult {
  products: { id: string; sku: string; nameAr: string; nameEn: string; status: string }[];
  orders: { id: string; salesOrderNumber: string; status: string; grandTotal: number; orderDate: Date }[];
}

const SECTION_CAP = 20;

export async function globalSearch(companyId: string, query: string): Promise<SearchResult> {
  const q = query.trim();
  if (q === "") return { products: [], orders: [] };

  const [products, orders] = await Promise.all([
    prisma.product.findMany({
      where: {
        companyId,
        OR: [
          { sku: { contains: q } },
          { nameAr: { contains: q } },
          { nameEn: { contains: q } },
          { barcode: { contains: q } },
        ],
      },
      select: { id: true, sku: true, nameAr: true, nameEn: true, status: true },
      orderBy: { sku: "asc" },
      take: SECTION_CAP,
    }),
    prisma.salesOrder.findMany({
      where: { companyId, salesOrderNumber: { contains: q } },
      select: {
        id: true, salesOrderNumber: true, status: true,
        grandTotal: true, orderDate: true,
      },
      orderBy: { salesOrderNumber: "desc" },
      take: SECTION_CAP,
    }),
  ]);

  return { products, orders };
}
