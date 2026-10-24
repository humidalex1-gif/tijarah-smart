import { notFound } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, getTranslator } from "@/lib/i18n";
import { loadAppContext, requirePermission } from "@/lib/appContext";
import { prisma } from "@/lib/db";
import { ProductForm, type ProductFormLabels } from "../../ProductForm";

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ctx = await loadAppContext(locale);
  requirePermission(ctx, "products.edit", locale);
  const t = await getTranslator(locale);

  const product = await prisma.product.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!product) notFound();

  const [categories, brands, warehouses] = await Promise.all([
    prisma.productCategory.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { nameEn: "asc" },
    }),
    prisma.brand.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);

  const labels: ProductFormLabels = {
    sectionBasicInfo: t("products.sectionBasicInfo"),
    sectionPricing: t("products.sectionPricing"),
    sectionInventory: t("products.sectionInventory"),
    sectionPhysicalDetails: t("products.sectionPhysicalDetails"),
    nameAr: t("products.nameAr"), nameEn: t("products.nameEn"), sku: t("products.sku"),
    barcode: t("products.barcode"), category: t("products.category"), brand: t("products.brand"),
    descriptionAr: t("products.descriptionAr"), descriptionEn: t("products.descriptionEn"),
    purchasePrice: t("products.purchasePrice"), sellingPrice: t("products.sellingPrice"),
    wholesalePrice: t("products.wholesalePrice"), minSellingPrice: t("products.minSellingPrice"),
    taxRate: t("products.taxRate"),
    reorderLevel: t("products.reorderLevel"), reorderQty: t("products.reorderQty"),
    trackInventory: t("products.trackInventory"), allowBackorder: t("products.allowBackorder"),
    openingQty: t("products.openingQty"), openingWarehouse: t("products.openingWarehouse"),
    weight: t("products.weight"), length: t("products.length"), width: t("products.width"),
    height: t("products.height"),
    save: t("app.save"), cancel: t("app.cancel"), none: t("app.none"),
    duplicateSku: t("products.duplicateSku"),
    addCategory: t("catalog.addCategory"), addBrand: t("catalog.addBrand"),
    categoryNameAr: t("catalog.categoryNameAr"), categoryNameEn: t("catalog.categoryNameEn"),
    brandName: t("catalog.brandName"),
    // Same map as the create page — see the comment there. updateProductAction
    // can't return OPENING_STOCK_FAILED (no opening stock on edit) but the
    // key is harmless to include and keeps this map identical to create's.
    errors: {
      "errors.generic": t("errors.generic"),
      "errors.DUPLICATE_CATEGORY": t("errors.DUPLICATE_CATEGORY"),
      "errors.DUPLICATE_BRAND": t("errors.DUPLICATE_BRAND"),
      "errors.DUPLICATE_SKU": t("errors.DUPLICATE_SKU"),
      "errors.OPENING_PRICE_REQUIRED": t("errors.OPENING_PRICE_REQUIRED"),
      "errors.OPENING_WAREHOUSE_REQUIRED": t("errors.OPENING_WAREHOUSE_REQUIRED"),
      "errors.OPENING_STOCK_FAILED": t("errors.OPENING_STOCK_FAILED"),
      "errors.FORBIDDEN": t("errors.FORBIDDEN"),
      "errors.NOT_FOUND": t("errors.NOT_FOUND"),
      // Same map as the create page — see the comment there. updateProductAction
      // has no opening-stock path, but the fields these guard (price, SKU,
      // tax rate) are edited here too, so the keys stay meaningful on this
      // page as well (Stage 1B review, IMPORTANT 6).
      "errors.QUANTITY_MUST_BE_POSITIVE": t("errors.QUANTITY_MUST_BE_POSITIVE"),
      "errors.AMOUNT_OUT_OF_RANGE": t("errors.AMOUNT_OUT_OF_RANGE"),
      "errors.INVALID_PRICE": t("errors.INVALID_PRICE"),
      "errors.INVALID_SKU": t("errors.INVALID_SKU"),
      "errors.INVALID_TAX_RATE": t("errors.INVALID_TAX_RATE"),
    },
  };

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-navy">{t("app.edit")}: {locale === "ar" ? product.nameAr : product.nameEn}</h1>
      <ProductForm
        locale={locale}
        mode="edit"
        productId={product.id}
        defaults={{
          nameAr: product.nameAr, nameEn: product.nameEn, sku: product.sku,
          barcode: product.barcode ?? "",
          categoryId: product.categoryId ?? "", brandId: product.brandId ?? "",
          descriptionAr: product.descriptionAr ?? "", descriptionEn: product.descriptionEn ?? "",
          purchasePrice: product.purchasePrice, sellingPrice: product.sellingPrice,
          wholesalePrice: product.wholesalePrice, minSellingPrice: product.minSellingPrice,
          taxRatePct: product.taxRatePct,
          weightGrams: product.weightGrams, lengthMm: product.lengthMm,
          widthMm: product.widthMm, heightMm: product.heightMm,
          reorderLevel: product.reorderLevel, reorderQty: product.reorderQty,
          trackInventory: product.trackInventory, allowBackorder: product.allowBackorder,
        }}
        categories={categories.map((c) => ({ id: c.id, nameAr: c.nameAr, nameEn: c.nameEn }))}
        brands={brands.map((b) => ({ id: b.id, name: b.name }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        labels={labels}
      />
    </div>
  );
}
