/**
 * Container/codec sniffing for inbound and outbound media.
 *
 * Every decision here is made from the **bytes**, never from the filename:
 * sending an AVI/WebM/ProRes file to Feishu as if it were an MP4 produces a
 * bubble the client cannot play, which is worse than the click-to-open file
 * attachment it would otherwise be. So a file only takes the inline-preview
 * path when its container *and* codec are known to play.
 *
 * @module @starxer/chatterbox4dsh/media-sniff
 */

export type ImageMediaTypeId = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

/**
 * Sniff the real media type from the first bytes of an image, independent of
 * any filename/MIME hint. The attachment store validates declared vs actual
 * bytes (`IMAGE_TYPE_MISMATCH`), so we must NOT guess — Feishu only exposes
 * `type: 'image'` with no reliable content hint, and a guessed JPEG stamp will
 * reject every non-JPEG upload (PNG/WebP/GIF).
 */
export function sniffImageMime(bytes: Uint8Array): ImageMediaTypeId | undefined {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // WebP: "RIFF" .... "WEBP"
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  // GIF: "GIF87a" / "GIF89a"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 &&
      (b[3] === 0x38) && (b[5] === 0x61)) return 'image/gif'
  return undefined
}

/** Result of a video sniff: the ISO-BMFF container kind plus the video codec. */
export interface VideoContainer {
  /** `'mp4'` for an MP4/ISO brand, `'mov'` for a QuickTime brand. */
  container: 'mp4' | 'mov'
  /** Sample-entry fourcc of the first video track, e.g. `avc1` / `hvc1`. */
  codec: string
}

/**
 * ISO-BMFF brands we treat as MP4. `qt  ` (QuickTime) is handled separately:
 * a `.mov` is byte-identical in structure to an `.mp4`, and macOS screen
 * recordings are H.264 `.mov`, so it is worth accepting — but only after the
 * codec check, which is what keeps ProRes `.mov` out.
 */
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9',
  'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'MSNV', 'M4V ', 'M4VH', 'M4VP',
])

/**
 * Video codecs Feishu clients actually play. Anything else (ProRes `apcn`,
 * VP9 `vp09`, AV1 `av01`, …) keeps the plain file attachment, which the user
 * can still download and play locally.
 */
const PLAYABLE_VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v'])

interface Box {
  type: string
  /** First byte of the box payload (after size/type/largesize). */
  start: number
  /** One past the last byte of the box. */
  end: number
}

/** Read a 4-character box type / brand at `offset` (callers bound-check first). */
function fourcc(bytes: Uint8Array, offset: number): string {
  const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2], d = bytes[offset + 3]
  if (a === undefined || b === undefined || c === undefined || d === undefined) return ''
  return String.fromCharCode(a, b, c, d)
}

/** Read a box header at `offset`, or `undefined` when the bytes are malformed. */
function readBox(bytes: Uint8Array, offset: number, limit: number): Box | undefined {
  if (offset + 8 > limit) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let size = view.getUint32(offset)
  const type = fourcc(bytes, offset + 4)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > limit) return undefined
    // 64-bit largesize; anything past 2^53 is beyond a file we could hold.
    const big = view.getBigUint64(offset + 8)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    size = Number(big)
    headerSize = 16
  } else if (size === 0) {
    // "extends to the end of the enclosing box"
    size = limit - offset
  }
  if (size < headerSize || offset + size > limit) return undefined
  return { type, start: offset + headerSize, end: offset + size }
}

/** Depth-first search for the first direct child box of `type` in `[start, end)`. */
function findBox(bytes: Uint8Array, start: number, end: number, type: string): Box | undefined {
  let offset = start
  // Bounded to keep a crafted file from spinning here.
  for (let guard = 0; guard < 4096 && offset + 8 <= end; guard++) {
    const box = readBox(bytes, offset, end)
    if (box === undefined) return undefined
    if (box.type === type) return box
    offset = box.end
  }
  return undefined
}

/** Every direct child box of `type` in `[start, end)`, in file order. */
function findBoxes(bytes: Uint8Array, start: number, end: number, type: string): Box[] {
  const found: Box[] = []
  let offset = start
  for (let guard = 0; guard < 4096 && offset + 8 <= end; guard++) {
    const box = readBox(bytes, offset, end)
    if (box === undefined) return found
    if (box.type === type) found.push(box)
    offset = box.end
  }
  return found
}

/** First video sample-entry fourcc from `stsd` (`moov → trak → mdia → minf → stbl`). */
function findVideoCodec(bytes: Uint8Array, moov: Box): string | undefined {
  for (const trak of findBoxes(bytes, moov.start, moov.end, 'trak')) {
    const mdia = findBox(bytes, trak.start, trak.end, 'mdia')
    if (mdia === undefined) continue
    const minf = findBox(bytes, mdia.start, mdia.end, 'minf')
    if (minf === undefined) continue
    const stbl = findBox(bytes, minf.start, minf.end, 'stbl')
    if (stbl === undefined) continue
    const stsd = findBox(bytes, stbl.start, stbl.end, 'stsd')
    if (stsd === undefined) continue
    // stsd payload: version+flags (4) then entry_count (4), then the entries.
    const entry = readBox(bytes, stsd.start + 8, stsd.end)
    if (entry === undefined) continue
    // An audio track (`mp4a`) is not a video track — keep looking.
    if (entry.type === 'mp4a') continue
    return entry.type
  }
  return undefined
}

/**
 * Sniff an ISO-BMFF (MP4 / QuickTime) video that Feishu can play inline.
 *
 * Returns `undefined` unless the file is a real ISO-BMFF container with a
 * video track whose codec is in {@link PLAYABLE_VIDEO_CODECS}; the caller then
 * falls back to sending a plain file attachment. The SDK additionally needs to
 * parse the duration from `moov → mvhd`, so a container without a readable
 * `moov` is refused here as well.
 */
export function sniffVideoContainer(bytes: Uint8Array): VideoContainer | undefined {
  if (bytes.length < 12) return undefined
  const ftyp = readBox(bytes, 0, bytes.length)
  if (ftyp === undefined || ftyp.type !== 'ftyp' || ftyp.end - ftyp.start < 8) return undefined

  const majorBrand = fourcc(bytes, ftyp.start)
  let container: VideoContainer['container'] | undefined
  if (MP4_BRANDS.has(majorBrand)) {
    container = 'mp4'
  } else if (majorBrand === 'qt  ') {
    container = 'mov'
  } else {
    // Fall back to the compatible-brands list (brands 2..n, 4 bytes each).
    for (let i = ftyp.start + 8; i + 4 <= ftyp.end; i += 4) {
      const brand = fourcc(bytes, i)
      if (brand === 'qt  ') { container = 'mov'; break }
      if (MP4_BRANDS.has(brand)) { container = 'mp4'; break }
    }
  }
  if (container === undefined) return undefined

  const moov = findBox(bytes, 0, bytes.length, 'moov')
  if (moov === undefined) return undefined
  // The SDK resolves the upload duration from mvhd and throws without it.
  if (findBox(bytes, moov.start, moov.end, 'mvhd') === undefined) return undefined
  const codec = findVideoCodec(bytes, moov)
  if (codec === undefined || !PLAYABLE_VIDEO_CODECS.has(codec)) return undefined
  return { container, codec }
}

/**
 * Sniff Ogg/Opus audio, the only shape Feishu renders as a voice bubble.
 * Anything else (mp3/m4a/wav) keeps the file attachment: the SDK would upload
 * it as `file_type: 'opus'` and the client could not play it.
 */
export function sniffAudioContainer(bytes: Uint8Array): 'opus' | undefined {
  // Ogg page capture pattern at offset 0, then the OpusHead identification
  // header inside the first page's segment payload.
  if (bytes.length < 4) return undefined
  if (!(bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53)) return undefined
  const needle = 'OpusHead'
  const limit = Math.min(bytes.length, 256)
  outer: for (let i = 0; i + needle.length <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer
    }
    return 'opus'
  }
  return undefined
}
