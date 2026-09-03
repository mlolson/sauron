// Builds build/icon.png from resources/eye.png: crops to the drawing, removes the faint
// pink watermark pixels, and composes the result on a cream rounded square.
import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 3, let source = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: make-icon.swift <source.png> <out.png>\n".data(using: .utf8)!)
    exit(2)
}
var rect = NSRect(origin: .zero, size: source.size)
guard let cg = source.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { exit(1) }

// Crop box in source pixels (the eye and its lashes, watermarks left out where possible).
let crop = CGRect(x: 90, y: 55, width: 810, height: 610)
guard let cropped = cg.cropping(to: crop) else { exit(1) }

// Read pixels, blank out anything pinkish (the watermark) and near-white (the background).
let w = cropped.width, h = cropped.height
let cs = CGColorSpaceCreateDeviceRGB()
// The context must own a stable buffer; passing a Swift array by & only lends a temporary pointer.
let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4)
buffer.initialize(repeating: 0, count: w * h * 4)
guard let ctx = CGContext(data: buffer, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: w, height: h))
let pixels = UnsafeMutableBufferPointer(start: buffer, count: w * h * 4)
var cleared = 0
for i in stride(from: 0, to: pixels.count, by: 4) {
    let a = Int(pixels[i+3])
    if a == 0 { continue }
    // Un-premultiply so translucent watermark pixels are classified by their true color.
    let r = Int(pixels[i]) * 255 / a, g = Int(pixels[i+1]) * 255 / a, b = Int(pixels[i+2]) * 255 / a
    let pinkish = r > 180 && b > 160 && (r - g) >= 8 && (b - g) >= -10
    let nearWhite = r > 225 && g > 225 && b > 225
    let translucentLight = a < 250 && r > 150 && g > 120 && b > 120 && !(r > 200 && g < 200 && b < 120)
    // The vendor watermark is translucent red; the drawing's orange has much more green.
    let translucentRed = a < 200 && r > 180 && g < 110 && b < 110
    if pinkish || nearWhite || translucentLight || translucentRed {
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0
        cleared += 1
    }
}
print("cleared \(cleared) watermark/background pixels")
guard let cleaned = ctx.makeImage() else { exit(1) }

// Compose on a 1024 canvas: cream rounded square, eye scaled to fit with padding.
let size = 1024
guard let out = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
let inset: CGFloat = 64
let bg = CGPath(roundedRect: CGRect(x: inset, y: inset, width: CGFloat(size) - 2 * inset, height: CGFloat(size) - 2 * inset),
                cornerWidth: 200, cornerHeight: 200, transform: nil)
out.addPath(bg)
out.setFillColor(CGColor(red: 0.965, green: 0.945, blue: 0.90, alpha: 1))
out.fillPath()
// White sclera behind the drawing so the pupil and lines sit on paper, not cream.
let pad: CGFloat = 120
let avail = CGFloat(size) - 2 * pad
let scale = min(avail / CGFloat(w), avail / CGFloat(h))
let dw = CGFloat(w) * scale, dh = CGFloat(h) * scale
let dx = (CGFloat(size) - dw) / 2, dy = (CGFloat(size) - dh) / 2
out.interpolationQuality = .high
out.draw(cleaned, in: CGRect(x: dx, y: dy, width: dw, height: dh))
guard let final = out.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: final)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: args[2]))
print("wrote \(args[2])")
