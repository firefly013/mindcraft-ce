import { readFileSync } from 'node:fs';

let keys: Record<string, string> = {};
try {
  const data = readFileSync('./keys.json', 'utf8');
  keys = JSON.parse(data) as Record<string, string>;
} catch {
  console.warn('keys.json not found. Defaulting to environment variables.'); // still works with local models
}

export function getKey(name: string): string {
  let key: string | undefined = keys[name];
  if (!key) {
    key = process.env[name];
  }
  if (!key) {
    throw new Error(`API key "${name}" not found in keys.json or environment variables!`);
  }
  return key;
}

export function hasKey(name: string): string | undefined {
  return keys[name] ?? process.env[name];
}
