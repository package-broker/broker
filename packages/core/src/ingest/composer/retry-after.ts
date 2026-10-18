export const MAX_RETRY_AFTER_SECONDS = 86400;

export function retryAfterOf(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS);
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at) || new Date(at).toUTCString() !== value) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil((at - now) / 1000)));
}
