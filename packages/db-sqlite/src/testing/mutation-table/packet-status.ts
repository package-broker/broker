/** Deferrals fail closed unless their owner has an explicit open status. */
export const packetStatuses: Readonly<Record<string, 'open' | 'done' | 'superseded'>> = {
  T782n: 'done',
};
