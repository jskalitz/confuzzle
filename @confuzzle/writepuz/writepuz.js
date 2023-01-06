const puz_common = require('@confuzzle/puz-common');
const iconv = require('iconv-lite');

function checksum(base, c, len) {
  if (c === undefined)
    c = 0x0000;
  
  if (base === undefined)
    return c;

  let x = Buffer.from(base);

  if (len === undefined)
    len = x.length;

  for (let i = 0; i < len; i++) {
    if (c & 0x0001)
      c = ((c >>> 1) + 0x8000) & 0xFFFF;
    else
      c = (c >>> 1);
    c = (c + x[i]) & 0xFFFF;
  }
  return c;
}

function writeCheatChecksum(buf, offset, key, checksums) {
    const n = checksums.length;
    for (let shift = 0; shift < 2; shift++) {
        for (let i = 0; i < checksums.length; i++) {
            const c = (checksums[i] & (0xFF << 8*shift)) >>> 8*shift;
            buf[offset + i + n*shift] = key.charCodeAt(i + n*shift) ^ c;
        }
    }
}

const enc = puz_common.puzEncode;

function nullByte() {
    return Buffer.from([0]);
}

function buildStrings(puz) {
    let strings = [];
    const fields = puz_common.PUZ_STRING_FIELDS;

    for (let i = 0; i < fields.length; i++)
        strings.push(enc(puz[fields[i]], true));

    for (let i = 0; i < puz.clues.length; i++)
        strings.push(enc(puz.clues[i], true));
    
    if (puz.note)
        strings.push(enc(puz.note));

    /* need a null terminator even if notes are empty */
    strings.push(nullByte());

    return Buffer.concat(strings);
}

function stringsChecksum(puz, c) {
    c = checksum(enc(puz.title, true), c);
    c = checksum(enc(puz.author, true), c);
    c = checksum(enc(puz.copyright, true), c);
    for (let i = 0; i < puz.clues.length; i++)
        c = checksum(enc(puz.clues[i]), c);

    if (puz.note)
        c = checksum(enc(puz.note, true), c);

    return c;
}

function buildBody(puz) {
    let body = enc(puz.solution);
    body = puz_common.concatBytes(body, enc(puz_common.puzState(puz)));
    return puz_common.concatBytes(body, buildStrings(puz));
}

function buildExtras(puz) {
  // Currently only supports rebus and circled/shaded cells
  const p = puz_common.PUZ_EXTRAS_CONSTANTS;
  let markup = [];
  let rebusLocations = [];
  let rebusSolutions = [];

  if (puz.markup) {
    markup = new Uint8Array(p.lengths.HEADER + puz.markup.length + 1);
    markup.set(iconv.encode(p.titles.MARKUP, "utf-8"), p.offsets.TITLE);
    puz_common.writeUInt16LE(markup, p.offsets.LENGTH, puz.markup.length);
    puz_common.writeUInt16LE(markup, p.offsets.CHECKSUM, checksum(puz.markup));
    for (let i = 0; i < puz.markup.length; i++) {
      markup[i + p.offsets.DATA] = puz.markup[i];
    }
    // Each extra section ends in a null byte
    markup[markup.length - 1] = 0;
  }

  if (puz.rebus) {
    let rebusCount = 0;
    const rebusLocationBytes = new Uint8Array(puz.rebus.length);
    let rebusSolutionString = "";
    for (let i = 0; i < puz.rebus.length; i++) {
      if (puz.rebus[i]) {
        rebusLocationBytes[i] = rebusCount + 2;
        // Format: xx:rebus;
        // where xx is the 2-digit rebus index (left padded with a space if necessary)
        // and rebus is the rebus value
        // Note that rebus indices are 1-indexed (for ease of comparison with output from another program)
        rebusSolutionString += String(rebusCount + 1).padStart(2, ' ') + ":" + puz.rebus[i] + ";";
        // TODO: if rebus count hits triple digits, we should probably throw an exception.
        rebusCount++;
      } else {
        rebusLocationBytes[i] = 0;
      }
    }

    rebusLocations = new Uint8Array(p.lengths.HEADER + puz.rebus.length + 1);
    rebusLocations.set(iconv.encode(p.titles.REBUS_LOCATIONS, "utf-8"), p.offsets.TITLE);
    puz_common.writeUInt16LE(rebusLocations, p.offsets.LENGTH, puz.rebus.length);
    puz_common.writeUInt16LE(rebusLocations, p.offsets.CHECKSUM, checksum(rebusLocationBytes));
    rebusLocations.set(rebusLocationBytes, p.offsets.DATA);
    rebusLocations[rebusLocations.length - 1] = 0;

    rebusSolutions = new Uint8Array(p.lengths.HEADER + rebusSolutionString.length + 1);
    rebusSolutions.set(iconv.encode(p.titles.REBUS_CONTENTS, "utf-8"), p.offsets.TITLE);
    puz_common.writeUInt16LE(rebusSolutions, p.offsets.LENGTH, rebusSolutionString.length);
    puz_common.writeUInt16LE(rebusSolutions, p.offsets.CHECKSUM, checksum(rebusSolutionString));
    rebusSolutions.set(iconv.encode(rebusSolutionString, "utf-8"), p.offsets.DATA);
    rebusSolutions[rebusSolutions.length - 1] = 0;
  }
  extras = puz_common.concatBytes([], markup);
  extras = puz_common.concatBytes(extras, rebusLocations);
  extras = puz_common.concatBytes(extras, rebusSolutions);
  return extras;
}

function computeChecksums(puz, header) {
    const p = puz_common.PUZ_HEADER_CONSTANTS;
    const h = checksum(header.slice(p.offsets.WIDTH, p.lengths.HEADER));
    let c = checksum(enc(puz.solution), h);
    const state = puz_common.puzState(puz);
    c = checksum(enc(state), c);
    return {
        header: h,
        solution: checksum(enc(puz.solution)),
        state: checksum(enc(state)),
        strings: stringsChecksum(puz),
        file: stringsChecksum(puz, c)
    }
}

function buildHeader(puz) {
    const i = puz_common.PUZ_HEADER_CONSTANTS.offsets;
    const header = new Uint8Array(puz_common.PUZ_HEADER_CONSTANTS.lengths.HEADER);

    // metadata
    header.set(iconv.encode("ACROSS&DOWN", "utf-8"), i.MAGIC);
    header.set(iconv.encode("1.3", "utf-8"), i.VERSION);

    // dimensions
    header[i.WIDTH] = puz.width;
    header[i.HEIGHT] = puz.height;
    puz_common.writeUInt16LE(header, i.NUM_CLUES, puz.clues.length);

    // magical random bitmask, causes across lite to crash if not set :S
    header[i.UNKNOWN_BITMASK] = 0x01;

    // checksums
    const c = computeChecksums(puz, header);
    puz_common.writeUInt16LE(header, i.FILE_CHECKSUM, c.file);
    puz_common.writeUInt16LE(header, i.HEADER_CHECKSUM, c.header);
    writeCheatChecksum(header, i.ICHEATED_CHECKSUM, "ICHEATED", [
        c.header, c.solution, c.state, c.strings
    ]);
    return header;
}

function writepuz(puz) {
    let puzBytes = puz_common.concatBytes(buildHeader(puz), buildBody(puz));
    puzBytes = puz_common.concatBytes(puzBytes, buildExtras(puz));
    return puzBytes;
}

module.exports = {
    writepuz: writepuz
};

