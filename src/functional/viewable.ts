import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.scan().forEach(server=>ns.tprintf(server))
}
