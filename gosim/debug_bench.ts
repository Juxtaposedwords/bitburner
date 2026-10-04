import { it } from "vitest";
import { chooseMoveModeled } from "go/go_opponent_model";
import { sensibleMoves, eyesOf, evaluateBoard } from "go/go_decisions";
import { chainsOf, territory } from "go/go_engine";
import { playAgainstAI } from "./harness";

// GO_DEBUG_SEED=1005 npx vitest run --config gosim/vitest.config.ts gosim/debug_bench.ts
const show = (b: string[]) => [4, 3, 2, 1, 0].map((y) => b.map((c) => c[y]).join(" ")).join("\n");
it.skipIf(!process.env.GO_DEBUG_SEED)("trace a game", async () => {
  let shown = 0;
  const g = await playAgainstAI(async (b, m, h) => {
    const c = await chooseMoveModeled("Illuminati", b, m, h, { rolloutPlies: 4, followUp: false });
    if (c.kind === "pass" && shown++ < 2) {
      const owners = territory(b);
      const own = [...owners.entries()].filter(([, w]) => w === "X").map(([k]) => k);
      const chains = chainsOf(b, "X").map((ch) => `${ch.stones.length}st/${ch.liberties.size}lib/${eyesOf(b, ch)}eyes`);
      process.stderr.write(`PASS at:\n${show(b)}\nsensible=${sensibleMoves(b, m, h).length} ownArea=[${own.join(" ")}] chains=${chains.join(", ")} eval=${evaluateBoard(b, "X").toFixed(1)}\n\n`);
    }
    return c;
  }, "Illuminati", Number(process.env.GO_DEBUG_SEED));
  process.stderr.write(`final score ${g.score}: ${g.line.join(" ")}\n`);
});
