// Canonical task IDs (e.g. `github:owner/repo#123`) contain characters
// unsafe in filenames. Per spec §Filename encoding, every byte not in
// `[A-Za-z0-9._-]` is percent-encoded, lowercase.
//
// We *don't* delegate to `encodeURIComponent`: it leaves `!*'()` alone,
// uppercases the hex digits, and uses UTF-16 surrogate pairs instead
// of raw UTF-8 bytes. The spec says lowercase, byte-level, and
// "every byte not in the safe set", so we implement it directly.

const SAFE = new Set<number>();
for (const c of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-") {
  SAFE.add(c.charCodeAt(0));
}

const HEX = "0123456789abcdef";

export function encodeTaskId(id: string): string {
  const bytes = new TextEncoder().encode(id);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (SAFE.has(b)) {
      out += String.fromCharCode(b);
    } else {
      out += "%" + HEX[b >> 4]! + HEX[b & 0xf]!;
    }
  }
  return out;
}

export function decodeTaskId(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i]!;
    if (ch === "%") {
      if (i + 2 >= encoded.length) {
        throw new Error(`truncated percent-escape at index ${i}`);
      }
      const hi = encoded[i + 1]!;
      const lo = encoded[i + 2]!;
      // The spec emits lowercase; accept uppercase for robustness on
      // decode since older artefacts or hand-edited filenames may
      // exist.
      const hex = `${hi}${lo}`;
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error(`invalid percent-escape "%${hex}" at index ${i}`);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = ch.charCodeAt(0);
      if (code > 0x7f) {
        throw new Error(
          `unexpected non-ASCII character "${ch}" at index ${i}; encoded IDs must be pure ASCII`,
        );
      }
      bytes.push(code);
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(bytes),
  );
}
