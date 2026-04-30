// Theme presets. The first key is the default applied when the user
// has no saved theme. Bumping THEME_STORAGE_KEY forces existing users
// to migrate to the new default on next load.

export const THEME_STORAGE_KEY = 'ms_theme_v4'


// Acton | Belle Property official brand green over a clean neutral
// surface. Default theme — gives the app immediate visual identity
// for Belle Cottesloe. Other agencies can pick a different preset.
export const ACTON = {
  bg: '#FAFAF9',
  surface: '#FFFFFF',
  surfaceHover: '#F5F5F4',
  border: '#E7E5E4',
  text: '#0C0A09',
  textMuted: '#78716C',
  primary: '#386351',
}


// Neutral — warm white paper, near-black accent, no brand signature.
// White-label fallback for agencies that don't want the Acton green.
export const NEUTRAL = {
  bg: '#FAFAF9',
  surface: '#FFFFFF',
  surfaceHover: '#F5F5F4',
  border: '#E7E5E4',
  text: '#0C0A09',
  textMuted: '#78716C',
  primary: '#171717',
}


export const PRESETS = {
  'Acton | Belle': ACTON,
  'Neutral': NEUTRAL,
  'Terracotta & Jade': {
    bg: '#EFE2C7', surface: '#F7ECD4', surfaceHover: '#E5D3B0', border: '#D4C09A',
    text: '#1B3842', textMuted: '#5C6F77', primary: '#D2775A',
  },
  'Burgundy & Rye': {
    bg: '#E8D8B8', surface: '#F1E4C6', surfaceHover: '#D8C69D', border: '#BFA97A',
    text: '#1E1B14', textMuted: '#6B5E45', primary: '#8A2420',
  },
  'Nocturnal': {
    bg: '#0E1A28', surface: '#172739', surfaceHover: '#22334A', border: '#3A4B62',
    text: '#E4EAF1', textMuted: '#8FA3B8', primary: '#D4AA4A',
  },
}


export const DEFAULT_THEME = ACTON
