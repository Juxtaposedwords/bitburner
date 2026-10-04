# gosim: our Go strategies against the game's real AI

Local benchmarks only; nothing here ships to the game. The harness plays our moves
(`src/go/`) against the game's own IPvGO AI, loaded from a sparse clone of the game's
source *outside* this repo. The AI's 200 ms waits are stubbed out (`stubs/`), so a game
takes milliseconds.

    git clone --depth 1 --filter=blob:none --sparse https://github.com/bitburner-official/bitburner-src.git ../vendor/bitburner-src
    cd ../vendor/bitburner-src && git sparse-checkout set --no-cone '/src/Go/**' '/src/utils/**' '/src/Types/**' '/src/Casino/RNG.ts' '/license.txt'

Benchmarks (each skipped unless its variable is set):

- `GO_OURS=1 npx vitest run --config gosim/vitest.config.ts gosim/ours_bench.ts`: our
  opponent model (`go_opponent_model.ts`) against the real AI.
- `GO_FIDELITY=1 … gosim/fidelity_bench.ts`: how often our model predicts the AI's actual
  move.
- `strategies_bench.ts` (always runs), `grid_bench.ts` (`GO_GRID=1`),
  `verify_bench.ts` (`GO_VERIFY=1`): search-strategy comparisons.

Narrow the runs with `GO_GAMES=n` and `GO_OPPONENTS=Illuminati,Daedalus`.
