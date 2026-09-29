/**
 * Pure health checks for tools/status.ts - no `ns`. Each check turns a
 * snapshot of what the daemons already publish (status files, monitoring
 * rates, the scheduler's log) into findings. Every check here is a bug or
 * stall that once ran silently for hours before anyone noticed:
 * - gang equipment blocked by a savings target (BN10, $5.26T),
 * - 12 phantom gang casualties tripping the stand-down (BN10),
 * - batches firing with no second weaken, draining the target ("/W0"),
 * - a target stuck "not hackable" with zero hacking running,
 * - the player working a faction with nothing useful left to buy,
 * - daemons that never launched on a small home.
 */

export type Level = "ERROR" | "WARN" | "info";
export type Finding = { level: Level; message: string };

export type StatusSnapshot = {
  nowMs: number;
  // Scripts running on home (filenames, no leading slash).
  running: string[];
  expected: { script: string; core: boolean }[];
  cash: number;
  // Per-minute rates over the recent window, from monitoring; undefined without data.
  rates: { hacking?: number; gang?: number; gangExpenses?: number; cash?: number; karma?: number };
  // Hacking income per minute over a longer baseline window (3h), to spot a collapse.
  hackingBaseline?: number;
  savings?: { amount: number; reason: string };
  faction?: {
    workTarget?: string;
    repTargets?: Record<string, number>;
    favorPlan?: { faction: string }[];
    karmaCrime?: string;
    writtenAt: number;
  };
  gang?: { territory: number; worstWinChance: number; engaged: boolean; writtenAt: number };
  gangCasualties?: { casualties: number; maxCasualties: number };
  sleeves?: { sleeves: { index: number; goal: string }[]; writtenAt: number };
  installPending?: { since: number; phase?: string };
  schedulerLogTail: string[];
};

// A status file older than this means its writer has stopped.
export const STALE_MS = 2 * 60_000;
const MINUTE_MS = 60_000;

export function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) if (abs >= size) return `$${(n / size).toFixed(abs / size >= 100 ? 0 : 1)}${suffix}`;
  return `$${n.toFixed(0)}`;
}

/** Seconds since midnight from a log line's "[3:25:35 PM]" prefix; undefined if there isn't one. */
export function logLineSeconds(line: string): number | undefined {
  const m = /^\[(\d{1,2}):(\d{2}):(\d{2}) (AM|PM)\]/.exec(line);
  if (!m) return undefined;
  const hour = (Number(m[1]) % 12) + (m[4] === "PM" ? 12 : 0);
  return hour * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export type SchedulerSummary = {
  target?: string;
  fired: number;
  prep: number;
  notHackable: number;
  noFit: number;
  batchesPerMin?: number;
  lastWarning?: string;
};

/** What the scheduler's recent log says: current target, batch rate, and the latest warning. */
export function summarizeScheduler(lines: string[]): SchedulerSummary {
  const fired = lines.filter((l) => l.includes("Fired batch"));
  const lastTarget = [...lines]
    .reverse()
    .map((l) => /Fired batch on ([^:]+):|Prep \w+ on ([^:]+):|Retargeting \S+ -> ([^.]+)\.|^.*?\] (?:\[Scheduler\] )*(\S+) not hackable/.exec(l))
    .find((m) => m);
  const times = fired.map(logLineSeconds).filter((t): t is number => t !== undefined);
  let span = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
  if (span < 0) span += 24 * 3600; // crossed midnight
  const warnings = lines.filter((l) => l.includes("[WARN"));
  return {
    target: lastTarget ? (lastTarget[1] ?? lastTarget[2] ?? lastTarget[3] ?? lastTarget[4])?.trim() : undefined,
    fired: fired.length,
    prep: lines.filter((l) => l.includes("Prep ")).length,
    notHackable: lines.filter((l) => l.includes("not hackable")).length,
    noFit: lines.filter((l) => l.includes("doesn't fit")).length,
    batchesPerMin: span > 0 ? ((times.length - 1) / span) * 60 : undefined,
    // Drop every leading "[...]" group: time, PID, level, and the logger's prefixes.
    lastWarning: warnings.length > 0 ? warnings[warnings.length - 1].replace(/^(\[[^\]]*\]\s*)+/, "") : undefined,
  };
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return "never";
  if (minutes < 90) return `${Math.ceil(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function daemonChecks(s: StatusSnapshot): Finding[] {
  const running = new Set(s.running);
  return s.expected
    .filter(({ script }) => !running.has(script))
    .map(({ script, core }) =>
      core
        ? { level: "ERROR" as const, message: `${script} is not running (core daemon).` }
        : { level: "WARN" as const, message: `${script} is not running (didn't fit on home, or crashed).` }
    );
}

function staleChecks(s: StatusSnapshot): Finding[] {
  const findings: Finding[] = [];
  const stale = (name: string, writtenAt: number | undefined): void => {
    if (writtenAt !== undefined && s.nowMs - writtenAt > STALE_MS) {
      findings.push({ level: "WARN", message: `${name} is ${formatMinutes((s.nowMs - writtenAt) / MINUTE_MS)} old - its daemon may have stopped.` });
    }
  };
  stale("/var/faction_reps.txt", s.faction?.writtenAt);
  stale("/var/gang_status.txt", s.gang?.writtenAt);
  stale("/var/sleeves.txt", s.sleeves?.writtenAt);
  return findings;
}

function schedulerChecks(s: StatusSnapshot): Finding[] {
  const findings: Finding[] = [];
  const lines = s.schedulerLogTail;
  if (lines.length === 0) return findings;
  if (lines.some((line) => line.includes("Fired batch") && line.includes("/W0."))) {
    findings.push({ level: "ERROR", message: "Batches are firing with no second weaken (/W0) - the target's security will climb until it drains." });
  }
  const notHackable = lines.filter((line) => line.includes("not hackable")).length;
  if (notHackable >= 5) findings.push({ level: "WARN", message: `Scheduler logged "not hackable" ${notHackable} times recently - batches aren't firing.` });
  const noFit = lines.filter((line) => line.includes("doesn't fit")).length;
  if (noFit >= 5) findings.push({ level: "info", message: `Scheduler: ${noFit} recent batches didn't fit in free RAM.` });
  if (!lines.some((line) => line.includes("Fired batch") || line.includes("Prep "))) {
    findings.push({ level: "WARN", message: "Scheduler's recent log shows no batches and no prep." });
  }
  return findings;
}

function incomeChecks(s: StatusSnapshot): Finding[] {
  const findings: Finding[] = [];
  if (s.rates.hacking !== undefined && s.rates.hacking <= 0) {
    findings.push({ level: "WARN", message: "No hacking income in the recent window." });
  } else if (s.rates.hacking !== undefined && s.hackingBaseline !== undefined && s.rates.hacking < s.hackingBaseline * 0.25) {
    findings.push({
      level: "WARN",
      message: `Hacking income dropped to ${formatMoney(s.rates.hacking)}/min from ${formatMoney(s.hackingBaseline)}/min over 3h - see the scheduler section.`,
    });
  }
  if (s.rates.cash !== undefined && s.rates.cash < 0) {
    findings.push({ level: "info", message: `Cash is falling ${formatMoney(-s.rates.cash)}/min - spending exceeds income.` });
  }
  if (s.savings && s.savings.amount > s.cash) {
    const gap = s.savings.amount - s.cash;
    const eta = s.rates.cash && s.rates.cash > 0 ? gap / s.rates.cash : Infinity;
    findings.push({
      level: eta > 24 * 60 ? "WARN" : "info",
      message: `Saving for ${s.savings.reason}: $${(gap / 1e9).toFixed(1)}B to go, ~${formatMinutes(eta)} at the current cash rate.`,
    });
  }
  return findings;
}

function gangChecks(s: StatusSnapshot): Finding[] {
  const findings: Finding[] = [];
  if (s.gangCasualties && s.gangCasualties.casualties >= s.gangCasualties.maxCasualties) {
    findings.push({
      level: "ERROR",
      message: `Gang stand-down: ${s.gangCasualties.casualties} casualties recorded - territory warfare is off. Check /var/gang_state.txt.`,
    });
  }
  if (s.gang && !s.gang.engaged && s.gang.worstWinChance >= 0.65 && s.gang.territory < 1) {
    findings.push({ level: "WARN", message: `Gang odds are ${(s.gang.worstWinChance * 100).toFixed(0)}% but territory warfare isn't engaged.` });
  }
  if (s.gang && s.rates.gangExpenses !== undefined && s.rates.gangExpenses === 0 && s.cash > 1e9) {
    findings.push({ level: "info", message: "Gang bought no equipment in the recent window despite cash on hand (fully equipped, or blocked)." });
  }
  return findings;
}

function workChecks(s: StatusSnapshot): Finding[] {
  const findings: Finding[] = [];
  const f = s.faction;
  if (f?.workTarget && !(f.workTarget in (f.repTargets ?? {})) && !(f.favorPlan ?? []).some((e) => e.faction === f.workTarget)) {
    findings.push({ level: "WARN", message: `Working for ${f.workTarget}, which has no useful rep target left.` });
  }
  if (f?.karmaCrime) {
    const match = /karma (-?\d+) \/ (-?\d+)/.exec(f.karmaCrime);
    const eta = match && s.rates.karma && s.rates.karma > 0 ? (Number(match[1]) - Number(match[2])) / s.rates.karma : undefined;
    findings.push({ level: "info", message: `Gang karma: ${f.karmaCrime}${eta !== undefined ? `, ~${formatMinutes(eta)} to go` : ""}.` });
  }
  for (const sleeve of s.sleeves?.sleeves ?? []) {
    if (sleeve.goal === "idle") findings.push({ level: "WARN", message: `Sleeve ${sleeve.index} is idle.` });
  }
  if (s.installPending && s.nowMs / 1000 - s.installPending.since > 30 * 60) {
    findings.push({
      level: "WARN",
      message: `An install has been pending (${s.installPending.phase ?? "augments"}) for ${formatMinutes((s.nowMs / 1000 - s.installPending.since) / 60)}.`,
    });
  }
  return findings;
}

const ORDER: Record<Level, number> = { ERROR: 0, WARN: 1, info: 2 };

/** Every finding, most severe first. */
export function checkStatus(s: StatusSnapshot): Finding[] {
  return [...daemonChecks(s), ...staleChecks(s), ...schedulerChecks(s), ...incomeChecks(s), ...gangChecks(s), ...workChecks(s)].sort(
    (a, b) => ORDER[a.level] - ORDER[b.level]
  );
}
