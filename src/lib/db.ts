import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Prisma 7 requires a driver adapter instead of a bare `datasource.url`.
// The connection string still comes from DATABASE_URL (dev.db locally,
// test.db under vitest — see tests/global-setup.ts). Constructed only inside
// the `??` fallback so a hot reload that finds an existing global client
// never opens (and immediately discards) a second sqlite connection.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }) });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** The transaction-scoped client type used by every service function. */
export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;
