export class RateLimited extends Error {
  readonly code = 'rate_limited';
  constructor(readonly resetEpochSeconds: number) {
    super('GitHub rate limit exhausted');
    this.name = 'RateLimited';
  }
}
