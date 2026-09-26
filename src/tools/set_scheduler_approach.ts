import { NS } from "@ns";
import { Codes } from "development/libraries/status";
import { Approach, NewSchedulerServiceClient } from "development/metadata/scheduler";

/**
 * Readable way to flip SchedulerConfig.approach - the persisted
 * /etc/scheduler.txt stores it as a bare enum number. Usage:
 * `run tools/set_scheduler_approach.js HACK` or `... STOCK_TARGETING`.
 * Takes effect within scheduler_daemon.js's next 1000ms tick and survives
 * restarts (PatchSchedulerConfig writes through to /etc/scheduler.txt).
 */
export async function main(ns: NS): Promise<void> {
  const name = ns.args[0] as string | undefined;
  const validNames = Object.keys(Approach).filter((key) => Number.isNaN(Number(key)));

  if (!name || !validNames.includes(name)) {
    ns.tprint(`[SetApproach] ERROR: expected one of ${validNames.join(", ")}, got "${name ?? ""}".`);
    return;
  }

  const approach = Approach[name as keyof typeof Approach];
  const res = await NewSchedulerServiceClient(ns).PatchSchedulerConfig({ config: { approach } });

  ns.tprint(
    res.status === Codes.OK
      ? `[SetApproach] scheduler_daemon.js's approach set to ${name}.`
      : `[SetApproach] ERROR (${Codes[res.status]}): ${res.error}`
  );
}
