// Apple-side proof for the app packs: inflate chunks with the Compression
// framework exactly as the app will (compression_decode_buffer with
// COMPRESSION_ZLIB, i.e. raw DEFLATE, RFC 1951) and print each one's length and
// sha256, for test/apple.test.mjs to compare with Node's inflateRawSync.
//
//   swift tools/app-packs/test/inflate.swift <file.bin> <offset>:<length>:<rawLength> …
//
// Prints one line per chunk: "<offset> <decodedBytes> <sha256hex>". Exits 1 if
// a chunk does not decode to exactly rawLength bytes.

import Foundation
import Compression
import CryptoKit

let args = CommandLine.arguments
guard args.count >= 3, let data = FileManager.default.contents(atPath: args[1]) else {
    FileHandle.standardError.write("usage: inflate.swift <file.bin> <offset>:<length>:<rawLength> …\n".data(using: .utf8)!)
    exit(2)
}

var failed = false
for spec in args.dropFirst(2) {
    let p = spec.split(separator: ":").compactMap { Int($0) }
    guard p.count == 3, p[0] >= 0, p[1] > 0, p[0] + p[1] <= data.count else {
        FileHandle.standardError.write("bad chunk spec \(spec)\n".data(using: .utf8)!)
        exit(2)
    }
    let (offset, length, rawLength) = (p[0], p[1], p[2])
    // One byte of headroom: a stream longer than rawLength fills it, and fails.
    let capacity = rawLength + 1
    let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
    defer { dst.deallocate() }
    let written = data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Int in
        let src = buf.baseAddress!.advanced(by: offset).assumingMemoryBound(to: UInt8.self)
        return compression_decode_buffer(dst, capacity, src, length, nil, COMPRESSION_ZLIB)
    }
    let digest = SHA256.hash(data: Data(bytesNoCopy: dst, count: written, deallocator: .none))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    print("\(offset) \(written) \(hex)")
    if written != rawLength { failed = true }
}
exit(failed ? 1 : 0)
