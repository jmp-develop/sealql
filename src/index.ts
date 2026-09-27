export { createSealer, Sealer, envelopeShape } from './core/field-cipher.js';
export type { Ciphertext, SealerSettings, CipherContext } from './core/field-cipher.js';
export { encodeField, decodeField, validateField } from './core/field-codec.js';
export type { FieldSpec, PlainOf, PlainValidator, JsonValue, SearchIndex, TextSearch } from './core/field-codec.js';
export { normalizeText, normalizeWords, exactBitsForPopulation, profiles, searchPieces, searchTokens } from './core/search-tokens.js';
export type { SearchProfile } from './core/search-tokens.js';
export { SealError } from './core/errors.js';
