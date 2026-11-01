export function isWorkflowFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/\p{Cs}/u.test(value) &&
    value.length >= 1 &&
    value.length <= 255 &&
    new TextEncoder().encode(value).length <= 255 &&
    /\.ya?ml$/.test(value) &&
    /^[\x20-\x7e\u0080-\u{10ffff}]+$/u.test(value) &&
    !/[/@]/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}
