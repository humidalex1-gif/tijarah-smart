import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { setUserPassword } from "@/services/accounts";

/**
 * Sets a strong password for the owner account.
 *
 * The seeded password (`demo12345`) is written in the seed file, printed by
 * every seed run, and shared in chat transcripts. It is fine on a laptop that
 * nothing else can reach. It is an open door on a public server holding the
 * business's costs, margins and third-party API credentials — so this must be
 * run BEFORE the app is first reachable from the internet.
 *
 * Usage on the server:
 *   node --env-file=.env --import tsx scripts/set-owner-password.ts
 *
 * A password is generated rather than accepted as an argument: an argument
 * lands in the shell history and in the process list, where any other user on
 * the machine can read it. The generated one is printed exactly once — save it
 * in a password manager before closing the terminal.
 */

/** Ambiguous characters removed: this gets read off a screen and retyped. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function strongPassword(length = 24): string {
  // Rejection sampling rather than `% ALPHABET.length`, which would bias the
  // first few characters of the alphabet and quietly weaken the password.
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

async function run() {
  const membership = await prisma.membership.findFirstOrThrow({
    where: { role: "OWNER" },
    include: { user: { select: { id: true, email: true } } },
  });

  const password = strongPassword();
  await setUserPassword(
    { companyId: membership.companyId, userId: membership.userId },
    membership.user.id,
    password,
  );

  console.log("");
  console.log("  Owner password changed.");
  console.log(`  Email:    ${membership.user.email}`);
  console.log(`  Password: ${password}`);
  console.log("");
  console.log("  Save it now — it is not stored anywhere and cannot be shown again.");
  console.log("");

  await prisma.$disconnect();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
