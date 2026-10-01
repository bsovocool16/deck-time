// Types for the plugin (TypeScript) importing the companion (JavaScript).
export function defaultHome(): string;
export function loadConfig(home?: string, edition?: 'full' | 'office'): { embedded?: boolean; edition?: string; port: number; [key: string]: unknown };
