/** True for a plain object, never null or an array. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for any string, including empty text. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** True for a string with something other than whitespace in it. */
export function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim() !== '';
}
