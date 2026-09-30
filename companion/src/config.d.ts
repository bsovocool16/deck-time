// Types for the plugin (TypeScript) importing the companion (JavaScript).
export function defaultHome(): string;
export function loadConfig(home?: string, edition?: 'full' | 'office'): { embedded?: boolean; port: number; [key: string]: unknown };
