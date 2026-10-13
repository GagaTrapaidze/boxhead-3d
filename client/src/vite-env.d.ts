/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the authoritative game server (see src/network/serverUrl.ts). */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
