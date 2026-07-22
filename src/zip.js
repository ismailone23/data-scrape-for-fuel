import zlib from "node:zlib";

// Europe PMC hands back figure images as a zip. Rather than pull in an archive
// dependency for one endpoint, entries are read straight out of the central
// directory, which is the only place stored sizes are trustworthy (streamed
// zips leave the local header's sizes zeroed and write them after the data).

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

function findEndOfCentralDirectory(buffer) {
  // The record is 22 bytes plus a comment of at most 64KB.
  const earliest = Math.max(0, buffer.length - (22 + 0xffff));

  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }

  return -1;
}

// Returns a Map of entry name to Buffer. Directories and unsupported
// compression methods are skipped rather than throwing, so one odd entry cannot
// cost us the rest of the archive.
export function readZipEntries(buffer) {
  const entries = new Map();
  const endOffset = findEndOfCentralDirectory(buffer);

  if (endOffset < 0) throw new Error("not a zip archive");

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if (method !== STORED && method !== DEFLATED) continue;
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) continue;

    // The local header's own name/extra lengths are authoritative for locating
    // the data; the central directory's extra field is often a different size.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      entries.set(name, method === STORED ? Buffer.from(data) : zlib.inflateRawSync(data));
    } catch {
      /* skip entry we cannot inflate */
    }
  }

  return entries;
}
