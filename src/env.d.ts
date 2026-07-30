/// <reference types="vite/client" />

/**
 * The environment variables the game reads.
 *
 * ⚠️ Vite **inlines** these values into the bundle during the `build`, and does not read
 * them at run time. Changing the room server's URL on the host requires a new build —
 * republishing the same artifact keeps the old value inside it.
 */
interface ImportMetaEnv {
  /**
   * The networked duel's room server: `ws://127.0.0.1:8787` in development,
   * `wss://<worker>.workers.dev` once published.
   *
   * Absent, online mode is born disabled with the reason on screen — see
   * `Menu.setOnlineAvailable`. That is on purpose: a game that opens normally and only
   * fails after two clicks is worse than one that says on the first screen what is
   * missing.
   */
  readonly VITE_ROOM_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
