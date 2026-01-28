export function hasProperty<K extends string>(
  obj: unknown,
  key: K,
  value?: unknown,
): obj is Record<K, unknown> {
  if (typeof obj !== 'object' || obj === null) return false;
  if (!(key in obj)) return false;
  if (value !== undefined && (obj as Record<K, unknown>)[key] !== value) return false;
  return true;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
