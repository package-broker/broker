export function redactComposerOutput(output: string, secrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    for (const value of [secret, `x-access-token:${secret}`, `${secret}:`]) {
      const base64 = Buffer.from(value).toString('base64');
      for (const form of [value, base64, base64.replaceAll('+', '-').replaceAll('/', '_')]) {
        forms.add(form);
        forms.add(form.replace(/=+$/, ''));
        forms.add(encodeURIComponent(form));
        forms.add(encodeURIComponent(encodeURIComponent(form)));
      }
    }
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    output = output.split(form).join('[redacted]');
  }
  return output;
}

export async function composerAvailable(
  check: () => Promise<unknown>,
  ci: string | null | undefined = process.env['CI'],
): Promise<boolean> {
  try {
    await check();
    return true;
  } catch {
    if (ci != null) throw new Error('ComposerUnavailable');
    return false;
  }
}
