import type { DomainPolicy, VerifiedIdentity } from './port.js';

const MAX_EMAIL_LENGTH = 254;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_PATTERN.test(domain) && /[a-z]/.test(domain.slice(domain.lastIndexOf('.') + 1));
}

export type PolicyDecision =
  | { readonly allow: true; readonly mayCreate: boolean }
  | { readonly allow: false; readonly reason: 'email_unverified' | 'domain_not_verified' };

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_EMAIL_LENGTH || !PRINTABLE_ASCII.test(trimmed)) {
    return null;
  }
  const email = trimmed.toLowerCase();
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || !isValidDomain(email.slice(at + 1))) {
    return null;
  }
  return email;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) {
    throw new TypeError('invalid e-mail');
  }
  return email.slice(at + 1);
}

export function evaluateDomainPolicy(
  identity: Pick<VerifiedIdentity, 'email' | 'emailVerified'>,
  policy: DomainPolicy,
): PolicyDecision {
  if (identity.emailVerified !== true) {
    return { allow: false, reason: 'email_unverified' };
  }
  const email = normalizeEmail(identity.email);
  const domains: unknown = policy.verifiedDomains;
  if (email === null || !Array.isArray(domains) || !domains.includes(emailDomain(email))) {
    return { allow: false, reason: 'domain_not_verified' };
  }
  return { allow: true, mayCreate: policy.autoJoin === true };
}

export function domainPolicyProblems(policy: DomainPolicy): string[] {
  const candidate: unknown = policy;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return ['policy must be an object'];
  }
  const problems: string[] = [];
  const domains: unknown = policy.verifiedDomains;
  if (typeof (policy.autoJoin as unknown) !== 'boolean') {
    problems.push('autoJoin must be a boolean');
  }
  if (!Array.isArray(domains)) {
    problems.push('verifiedDomains must be an array');
    return problems;
  }
  if (domains.length === 0) {
    problems.push('verifiedDomains must list at least one domain');
  }
  const seen = new Map<string, number>();
  for (let index = 0; index < domains.length; index += 1) {
    const domain: unknown = domains[index];
    if (typeof domain !== 'string') {
      problems.push(`verifiedDomains[${index}] must be a string`);
      continue;
    }
    if (domain.includes('*')) {
      problems.push(`verifiedDomains[${index}] must not contain a wildcard`);
    } else if (!isValidDomain(domain)) {
      problems.push(
        `verifiedDomains[${index}] must be a lowercase domain name of at most 253 characters with at least one dot and a last label containing a letter`,
      );
    }
    const first = seen.get(domain);
    if (first === undefined) {
      seen.set(domain, index);
    } else {
      problems.push(`verifiedDomains[${index}] duplicates verifiedDomains[${first}]`);
    }
  }
  return problems;
}
