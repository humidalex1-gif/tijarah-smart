import { defineConfig, env } from "prisma/config";

// Prisma 7 takes the migration/push connection string from here, not from a
// `datasource.url` (which it rejects with P1012), and it no longer auto-loads
// `.env`. tests/global-setup.ts passes DATABASE_URL explicitly; everything else
// falls back to the .env file written in Task 1.
if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: env("DATABASE_URL") },
});
