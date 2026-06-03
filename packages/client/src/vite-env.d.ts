/// <reference types="vite/client" />

/** The app version (package.json `version`), injected at build time by Vite's
 *  `define` (see vite.config.ts). Shown as the tiny footer version tag. */
declare const __APP_VERSION__: string;

/** The linked worktree serving the local dev client, or an empty string outside
 *  a linked worktree. Injected at build time by Vite. */
declare const __WORKTREE_LABEL__: string;

/** The full linked worktree label for hover display, or an empty string outside
 *  a linked worktree. Injected at build time by Vite. */
declare const __WORKTREE_FULL_LABEL__: string;
