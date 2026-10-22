const formatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
export function Time({ value, fallback = '—' }: { value: string | null; fallback?: string }) {
  if (value === null || !Number.isFinite(Date.parse(value)))
    return <span className="text-neutral-600">{fallback}</span>;
  return (
    <time dateTime={value} title={value} className="whitespace-nowrap tabular-nums">
      {formatter.format(new Date(value))}
    </time>
  );
}
