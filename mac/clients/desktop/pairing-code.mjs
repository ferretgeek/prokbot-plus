// The Host accepts separators; desktop IMEs can also emit full-width letters and digits.
export const normalizePairingCode = value => typeof value === 'string'
  ? value.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase() : '';
