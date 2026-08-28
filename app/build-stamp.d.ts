/** Injected by Vite at build time; see buildStamp() in vite.config.ts. */
declare const __BUILD__: string;

/*
 * The one Node call the Vite config makes. Declared here rather than pulling in
 * @types/node, which would add a dependency and a few thousand ambient names to
 * a project that runs in a browser and asks Node for exactly one string.
 */
declare module 'node:child_process' {
  export function execSync(command: string, options: { encoding: 'utf8' }): string;
}
