const date = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });
export function ListDate({ value }: { value: string }) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return <span>Date unavailable</span>;
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2">
        <time dateTime={value} title={`${exact.format(instant)} · ${instant.toISOString()}`}>
          {date.format(instant)}
        </time>
      </summary>
      <p className="text-xs">
        {exact.format(instant)}
        <br />
        {instant.toISOString()}
      </p>
    </details>
  );
}
