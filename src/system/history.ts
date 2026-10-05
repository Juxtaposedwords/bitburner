/**
 * Append-only records the game keeps the newest of (JSON lines): Go games,
 * installs. The newest `cap` stay in the game (save files stay small);
 * build/bridge.mjs appends each new line to game/archive/ on this machine,
 * which keeps them all for later evaluation.
 */
export function appendJsonLine(raw: string, entry: unknown, cap: number): string {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  lines.push(JSON.stringify(entry));
  return lines.slice(-cap).join("\n") + "\n";
}
