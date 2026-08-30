import { Format, UnsupportedFileError } from './types';

/** Detected from bytes only. The file extension is never trusted. */
export function sniffFormat(bytes: Uint8Array): Format {
  if (bytes.length === 0) throw new UnsupportedFileError('This file is empty.');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  throw new UnsupportedFileError('FilePass v0 supports JPEG, PNG and PDF files only.');
}

export const MAX_BYTES = 50 * 1024 * 1024;
