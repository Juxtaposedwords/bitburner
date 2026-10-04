import { it } from "vitest";
import { chooseMoveModeled } from "go/go_opponent_model";
import { playAgainstAI } from "./harness";

// Variants of the modeled search on fresh seeds (201+), against the real AI.
// GO_VARIANTS=1 npx vitest run --config gosim/vitest.config.ts gosim/variants_bench.ts
const GAMES = Number(process.env.GO_GAMES ?? 40);
const opponents = (process.env.GO_OPPONENTS ?? "Illuminati,Daedalus,Tetrads").split(",");
type Opts = Parameters<typeof chooseMoveModeled>[4];
const VARIANTS: [string, Opts][] = [
  ["model", { followUp: false }],
  ["model+follow", { followUp: true }],
  ["model x12", { followUp: false, samples: 12 }],
  ["rollout 2", { followUp: false, rolloutPlies: 2 }],
  ["rollout 4", { followUp: false, rolloutPlies: 4 }],
  ["rollout 2+follow", { followUp: true, rolloutPlies: 2 }],
  ["rollout 4 own", { followUp: false, rolloutPlies: 4, playOwnArea: true }],
  ["model own", { followUp: false, playOwnArea: true }],
  ["rollout 8", { followUp: false, rolloutPlies: 8 }],
  ["rollout 4 no-center", { followUp: false, rolloutPlies: 4, exclude: new Set(["2,2"]) }],
  ["rollout 8 x3", { followUp: false, rolloutPlies: 8, samples: 3 }],
  ["rollout 16 x3", { followUp: false, rolloutPlies: 16, samples: 3 }],
];

it.skipIf(!process.env.GO_VARIANTS)("modeled-search variants against the real AI", async () => {
  const only = process.env.GO_ONLY?.split(",");
  for (const opponent of opponents) {
    for (const [name, opts] of VARIANTS.filter(([n]) => !only || only.includes(n))) {
      let wins = 0, value = 0, wiped = 0, moves = 0, ms = 0, worst = 0;
      for (let seed = Number(process.env.GO_SEED ?? 201); seed < Number(process.env.GO_SEED ?? 201) + GAMES; seed++) {
        const g = await playAgainstAI(async (b, m, h) => {
          const t = Date.now();
          const first = !b.join("").includes("X");
          const c = await chooseMoveModeled(opponent, b, m, h, first && opts?.exclude ? opts : { ...opts, exclude: undefined });
          const d = Date.now() - t; ms += d; moves++; worst = Math.max(worst, d);
          return c;
        }, opponent, seed);
        wins += +g.won; value += g.value; wiped += +(g.score === 0);
      }
      // (per-variant rows below)
      process.stderr.write(`${opponent.padEnd(11)} ${name.padEnd(17)} ${wins}/${GAMES} won, wiped ${wiped}, value ${(value / GAMES).toFixed(1)}, ${(ms / moves).toFixed(0)} ms/move (worst ${worst})\n`);
    }
  }
});
