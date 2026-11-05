export default function matrixScanner(transport = fetch) {
  return {
    id: 'matrix-scanner',
    package: '@package-broker/core',
    apiVersion: 3,
    platforms: ['node', 'cloudflare'],
    publishPolicy: {
      id: 'matrix-scanner',
      async inspect(_org, input) {
        const body = await input.openTarball();
        const bytes = await new Response(body).arrayBuffer();
        if (bytes.byteLength !== input.sizeBytes) throw new Error('fixture_scan_size');
        const response = await transport(
          new Request(`https://scanner.matrix.test/${input.name}`, {
            signal: input.signal,
          }),
        );
        if (response.status !== 200) throw new Error('fixture_scan_failure');
        return { verdict: 'allow' };
      },
    },
  };
}
