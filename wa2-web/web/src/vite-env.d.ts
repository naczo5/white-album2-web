/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PACK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
