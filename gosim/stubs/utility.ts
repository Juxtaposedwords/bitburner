// The AI waits 200 ms per step in the game; locally, no wait.
export function sleep(): Promise<void> {
  return Promise.resolve();
}
