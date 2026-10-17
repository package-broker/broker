const ACCESS_KEY_ID_ANYWHERE = /(AKIA|ASIA)[A-Z0-9]{16}/;
const ACCESS_KEY_ID_WHOLE = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const TOKEN_RUN = /[A-Za-z0-9_-]{32,}/;
const BASE32_RUN = /^(?=[A-Z2-7]*[2-7])[A-Z2-7]{16,}$/;
const HEX_RUN = /^[0-9A-F]{16,}$/;
const VOWEL = /[AEIOU]/i;

function wordLooksLikeCredential(word: string, upperWord: string): boolean {
  return (
    BASE32_RUN.test(upperWord) ||
    HEX_RUN.test(upperWord) ||
    word.length >= 24 ||
    (word.length >= 20 && /[0-9]/.test(word) && /[A-Z]/.test(word)) ||
    (word.length >= 8 && !VOWEL.test(word))
  );
}

function isMixedWord(word: string): boolean {
  return word.length >= 4 && /[0-9]/.test(word) && /[A-Z]/.test(word);
}

export function containsCredentialToken(value: string): boolean {
  return ACCESS_KEY_ID_ANYWHERE.test(value) || TOKEN_RUN.test(value);
}

export function looksLikeCredential(value: string): boolean {
  if (containsCredentialToken(value) || ACCESS_KEY_ID_WHOLE.test(value.toUpperCase())) return true;
  for (const separators of [/_/, /[_.-]/]) {
    let mixed = 0;
    for (const word of value.split(separators)) {
      if (wordLooksLikeCredential(word, word.toUpperCase())) return true;
      if (isMixedWord(word)) mixed += 1;
    }
    if (mixed >= 2) return true;
  }
  return false;
}
