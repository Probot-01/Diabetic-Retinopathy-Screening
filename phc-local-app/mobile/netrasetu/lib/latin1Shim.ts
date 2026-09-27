/**
 * Expo's TextDecoder only knows UTF-8, and fast-png (the quality gate's PNG
 * decoder) does `new TextDecoder('latin1')` while its module loads, which throws
 * "Unknown encoding latin1" and kills the app before the first screen. This
 * wraps the global decoder so latin1 / iso-8859-1 / ascii work. It must be the
 * first import of App.tsx. Where the platform already supports latin1 it does nothing.
 */
const LATIN1 = /^(latin1|iso-8859-1|l1|ascii|us-ascii|windows-1252)$/i;

function supportsLatin1(): boolean {
  try { new TextDecoder('latin1'); return true; } catch { return false; }
}

class Latin1Decoder {
  readonly encoding = 'windows-1252';
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

export function installLatin1Decoder(): void {
  if (typeof TextDecoder === 'undefined' || supportsLatin1()) return;
  const Native = TextDecoder;
  const Patched = function (this: unknown, label?: string, options?: TextDecoderOptions) {
    return label && LATIN1.test(label) ? new Latin1Decoder() : new Native(label, options);
  } as unknown as typeof TextDecoder;
  (Patched as { prototype: unknown }).prototype = Native.prototype;
  globalThis.TextDecoder = Patched;
}

installLatin1Decoder();
