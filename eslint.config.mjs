import nextConfig from "eslint-config-next";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      // Prisma's generated client output, wherever the schema ends up
      // pointing it (default node_modules location is already covered above).
      "generated/**",
      "src/generated/**",
      "prisma/generated/**",
    ],
  },
  ...nextConfig,
];

export default config;
