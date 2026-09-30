// Types for the plugin (TypeScript) importing the companion (JavaScript).
export function startCompanion(options?: {
  home?: string;
  edition?: 'full' | 'office';
  publicDir?: string;
  port?: number;
  log?: (message: string) => void;
}): Promise<{ url: string; close(): void }>;
