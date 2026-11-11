/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by `vite --mode fixtures`: answer API calls from web/fixtures instead of a host. Never in a production build. */
  readonly MODE: string;
}
