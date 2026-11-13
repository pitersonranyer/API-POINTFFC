import { createHash } from 'crypto';

// Immutable v1: the four colors and three patterns of UI-POINTFFC TeamCrest.
export const CREST_CATALOG_VERSION = 'v1';
export const CREST_CATALOG = Object.freeze(
  ['#146b46', '#1b3028', '#a77c20', '#222222'].flatMap((color, colorIndex) =>
    [0, 1, 2].map(variant => Object.freeze({ id: `v1:c${colorIndex}:p${variant}`, color, variant }))),
);
export const CREST_IDS: readonly string[] = Object.freeze(CREST_CATALOG.map(item => item.id));
export function participantCrest(usuarioId: number, preference?: string | null): string {
  if (preference && CREST_IDS.includes(preference)) return preference;
  const hash = createHash('sha256').update(`point-ffc:participant-crest:v1:${usuarioId}`).digest();
  return CREST_IDS[hash.readUInt32BE(0) % CREST_IDS.length];
}
