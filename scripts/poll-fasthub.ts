import { prisma } from "@/lib/db";
import { pollFastHub } from "@/services/fasthub/poll";

/**
 * The unattended catch-up poll, run hourly by `tijarah-poll.timer`.
 *
 * It is the same `pollFastHub` the "زامن الآن" button calls, so there is one
 * sync path and not two that can drift apart. The only difference is where the
 * report goes: to the journal instead of the screen.
 *
 * It PRINTS everything, including the counts that are zero. A cron job whose
 * only output is silence cannot be told apart from a cron job that is not
 * running, and this project has already shipped one feature that was inert for
 * eight tasks because nothing revealed it.
 *
 * Exit code 1 when any resource failed, so systemd records the run as failed
 * and `systemctl list-timers` / `is-failed` tell the truth.
 */

async function run() {
  const company = await prisma.company.findFirst({ select: { id: true } });
  if (!company) {
    console.log("No company yet — nothing to poll.");
    return 0;
  }

  const connection = await prisma.fastHubConnection.findUnique({
    where: { companyId: company.id },
    select: { accessToken: true },
  });
  if (!connection?.accessToken) {
    // Not an error: an unconnected install is a legitimate state, and failing
    // hourly on it would train whoever reads the journal to ignore it.
    console.log("Fast Hub is not connected — nothing to poll.");
    return 0;
  }

  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { companyId: company.id, isDefault: true },
    select: { id: true, code: true },
  });

  const report = await pollFastHub(company.id, warehouse.id, warehouse.code ?? "", "SCHEDULED");

  const orders = report.orders;
  console.log(
    `orders: created=${orders?.created ?? "-"} seen=${orders?.alreadySeen ?? "-"} ` +
    `skipped=${orders?.skipped ?? "-"}`,
  );
  if (orders?.unknownSkus.length) console.log(`orders: UNKNOWN SKUS ${orders.unknownSkus.join(", ")}`);
  if (orders?.preOpening.length) console.log(`orders: PRE-OPENING, not imported ${orders.preOpening.join(", ")}`);
  if (orders?.failed.length) console.log(`orders: FAILED ${orders.failed.join(", ")}`);

  const returns = report.returns;
  console.log(
    `returns: opened=${returns?.opened ?? "-"} sellable=${returns?.settledSellable ?? "-"} ` +
    `damaged=${returns?.settledDamaged ?? "-"}`,
  );
  if (returns?.qcSplitMissing.length) {
    console.log(`returns: QC WITHOUT A SPLIT, left open ${returns.qcSplitMissing.join(", ")}`);
  }

  const inventory = report.inventory;
  const differing = inventory?.lines.filter((l) => l.difference !== 0) ?? [];
  console.log(`inventory: lines=${inventory?.lines.length ?? "-"} differing=${differing.length}`);
  for (const line of differing) {
    console.log(`inventory: ${line.sku} fasthub=${line.sellable / 1000} books=${line.booksAvailable / 1000}`);
  }

  for (const failure of report.failures) {
    console.error(`FAILED ${failure.resource}: ${failure.message}`);
  }
  return report.failures.length > 0 ? 1 : 0;
}

run()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
