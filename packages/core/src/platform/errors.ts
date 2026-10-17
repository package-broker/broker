export class PlatformUnavailableError extends Error {
  constructor() {
    super('Platform services are not enabled');
    this.name = 'PlatformUnavailableError';
  }
}
