import { NS } from "@ns";

/**
 * Edits one key of a JSON config file (/etc/*.txt) in place, leaving every
 * other key as it is:
 *
 *   run tools/set_config.js /etc/hacknet.txt hashSpendPriority '["Improve Studying"]'
 *   run tools/set_config.js /etc/hacknet.txt --unset hashSpendPriority
 *
 * The value is parsed as JSON when it can be (numbers, booleans, arrays), else
 * kept as a string. --unset removes the key, so the daemon's own default
 * applies again - loadJsonConfig (config.ts) fills in missing keys, and
 * existing keys win over defaults, which is why a changed default never
 * reaches an existing file on its own.
 */
export function applyConfigEdit(raw: string, key: string, value: string | undefined): string {
  const config = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (value === undefined) {
    delete config[key];
  } else {
    try {
      config[key] = JSON.parse(value);
    } catch {
      config[key] = value;
    }
  }
  return JSON.stringify(config, null, 2);
}

export async function main(ns: NS): Promise<void> {
  const args = ns.args.map(String);
  const unset = args.includes("--unset");
  const [path, key, value] = args.filter((a) => a !== "--unset");

  if (!path || !key || (!unset && value === undefined)) {
    ns.tprint("usage: run tools/set_config.js <path> <key> <json-value>  |  <path> --unset <key>");
    return;
  }

  let updated: string;
  try {
    updated = applyConfigEdit(ns.read(path), key, unset ? undefined : value);
  } catch (error) {
    ns.tprint(`ERROR: ${path} is not valid JSON, not touching it: ${error}`);
    return;
  }
  ns.write(path, updated, "w");
  ns.tprint(`${path}:\n${updated}`);
}
