/**
 * Synthetic media bytes for tests.
 *
 * Hand-built containers, so the sniffing logic is exercised against the real
 * ISO-BMFF box structure without shipping binary fixtures: `ftyp` + a video
 * track under `moov → trak → mdia → minf → stbl → stsd`, plus the `mvhd` the
 * SDK needs to resolve a duration.
 */

/** Build one ISO-BMFF box: 4-byte big-endian size, 4-byte type, then payload. */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

/** `ftyp` with a major brand and optional compatible brands. */
export function ftypBox(major: string, compatible: string[] = []): Buffer {
  return box('ftyp', Buffer.concat([
    Buffer.from(major, 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    ...compatible.map(brand => Buffer.from(brand, 'latin1')),
  ]))
}

const MVHD = box('mvhd', Buffer.alloc(96))

/** `stsd` holding a single sample entry of `codec`. */
export function stsdBox(codec: string): Buffer {
  const entry = box(codec, Buffer.alloc(16))
  return box('stsd', Buffer.concat([
    Buffer.from([0, 0, 0, 0]),           // version + flags
    Buffer.from([0, 0, 0, 1]),           // entry_count
    entry,
  ]))
}

/** `moov` with the given video codec (omit `codec` for an empty track). */
function moovBox(codec: string | undefined, withMvhd: boolean): Buffer {
  const stbl = codec === undefined ? box('stbl', Buffer.alloc(0)) : box('stbl', stsdBox(codec))
  const trak = box('trak', box('mdia', box('minf', stbl)))
  return box('moov', Buffer.concat(withMvhd ? [MVHD, trak] : [trak]))
}

/** A realistic MP4 (or QuickTime) header + video track, ready to be sniffed. */
export function mp4Bytes(options: {
  major?: string
  compatible?: string[]
  codec?: string
  mvhd?: boolean
} = {}): Buffer {
  return Buffer.concat([
    ftypBox(options.major ?? 'isom', options.compatible ?? ['isom', 'iso2', 'avc1', 'mp41']),
    moovBox(options.codec ?? 'avc1', options.mvhd !== false),
    box('mdat', Buffer.alloc(32)),
  ])
}

/** Minimal Ogg page carrying `payload` as its first packet (e.g. `OpusHead`). */
export function oggBytes(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from('OggS', 'latin1'),
    Buffer.alloc(20),
    Buffer.from(payload, 'latin1'),
    Buffer.alloc(40),
  ])
}
