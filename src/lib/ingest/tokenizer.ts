/**
 * Tokenizer surface used by the chunker (ADR-0004).
 *
 * In production this is the bundled embedding model's own tokenizer, so
 * chunk boundaries match the model's token accounting. Tests use a
 * word-level fake with the same contract.
 */
export interface Tokenizer {
  encode(text: string): number[];
  decode(ids: number[]): string;
}
