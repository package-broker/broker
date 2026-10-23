import type { ListingPage } from '../sources/provider.js';

interface RepositoryListingEvidence {
  readonly candidates: readonly string[];
  readonly enumerable: boolean;
}

// Keep built-in listing evidence out of the plugin API. Registry guards preserve page identity.
const evidence = new WeakMap<ListingPage, RepositoryListingEvidence>();

export function repositoryListing(
  page: ListingPage,
  input: RepositoryListingEvidence,
): ListingPage {
  evidence.set(page, input);
  return page;
}

export function repositoryListingEvidence(
  page: ListingPage,
): RepositoryListingEvidence | undefined {
  return evidence.get(page);
}
