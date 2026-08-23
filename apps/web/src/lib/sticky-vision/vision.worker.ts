/// <reference lib="webworker" />

// Vision worker — runs the OpenCV.js detection pipeline off the main thread.
//
// Pipeline per note:
//   1. Find contours via HSV mask + morphology (whole-image step).
//   2. Convex hull on the contour — closes any peeling/missing-corner gap so
//      a sticky with a curled corner becomes a clean convex polygon.
//   3. minAreaRect(hull) → smallest enclosing rotated rectangle, used for
//      handling tilted notes (the dominant distortion in hand-held photos).
//   4. Render a deskewed COLOR crop to an OffscreenCanvas via a canvas affine
//      transform (translate + rotate + drawImage). We deliberately use the
//      browser's drawImage here instead of OpenCV's warpAffine because
//      reading pixels back out of an OpenCV Mat into ImageData is fraught
//      (the Mat's row stride may include alignment padding that shifts each
//      row of the resulting image — that was the "lines pushed left/right"
//      bug we hit earlier).
//   5. From the deskewed color crop, build a separate "OCR-ready" version:
//      grayscale → CLAHE (local contrast) → adaptive threshold (binarize) →
//      2× upscale. Each step is a quoted ~10–20% accuracy boost on
//      Tesseract benchmarks for document-photo OCR; combined they often
//      take printed/clean handwriting from "mostly empty" to "readable".
//   6. Encode both crops to data URLs (color → thumbnail, OCR-ready → Tesseract).

import cv from "@techstark/opencv-js";
import type { ColorBucket, DetectedSticky } from "./detect";

interface DetectRequest {
	id: number;
	type: "detect";
	bitmap: ImageBitmap;
	maxLongEdge: number;
}

type IncomingMessage = DetectRequest;

interface DetectedResponse {
	id: number;
	type: "detected";
	stickies: DetectedSticky[];
}

interface ErrorResponse {
	id: number;
	type: "error";
	error: string;
}

type OutgoingMessage = DetectedResponse | ErrorResponse;

let cvReady: Promise<void> | null = null;
function ensureCv(): Promise<void> {
	if (cvReady) return cvReady;
	cvReady = new Promise<void>((resolve) => {
		const ready = (cv as any)?.Mat;
		if (ready) {
			resolve();
			return;
		}
		(cv as any).onRuntimeInitialized = () => resolve();
	});
	return cvReady;
}

self.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
	const data = event.data;
	if (!data || data.type !== "detect") return;
	const { id, bitmap, maxLongEdge } = data;

	try {
		await ensureCv();
		const stickies = await detectStickies(bitmap, maxLongEdge);
		try {
			bitmap.close();
		} catch {
			/* already closed */
		}
		const response: DetectedResponse = { id, type: "detected", stickies };
		(self as DedicatedWorkerGlobalScope).postMessage(response);
	} catch (err) {
		try {
			bitmap.close();
		} catch {
			/* already closed */
		}
		const response: ErrorResponse = {
			id,
			type: "error",
			error: err instanceof Error ? err.message : String(err),
		};
		(self as DedicatedWorkerGlobalScope).postMessage(response);
	}
});

async function detectStickies(
	bitmap: ImageBitmap,
	maxLongEdge: number,
): Promise<DetectedSticky[]> {
	const longEdge = Math.max(bitmap.width, bitmap.height);
	const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);

	const off = new OffscreenCanvas(width, height);
	const ctx = off.getContext("2d");
	if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
	ctx.drawImage(bitmap, 0, 0, width, height);
	const imgData = ctx.getImageData(0, 0, width, height);

	const src = cv.matFromImageData(imgData);
	const hsv = new cv.Mat();
	const mask = new cv.Mat();
	const contours = new cv.MatVector();
	const hierarchy = new cv.Mat();

	const disposables: any[] = [src, hsv, mask, contours, hierarchy];

	const results: DetectedSticky[] = [];

	try {
		const rgb = new cv.Mat();
		disposables.push(rgb);
		cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
		cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

		const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 60, 60, 0]);
		const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
			180, 255, 255, 255,
		]);
		disposables.push(lower, upper);
		cv.inRange(hsv, lower, upper, mask);

		const kSize = Math.max(7, Math.round(width / 200));
		const kernel = cv.getStructuringElement(
			cv.MORPH_RECT,
			new cv.Size(kSize, kSize),
		);
		disposables.push(kernel);
		cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
		cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);

		cv.findContours(
			mask,
			contours,
			hierarchy,
			cv.RETR_EXTERNAL,
			cv.CHAIN_APPROX_SIMPLE,
		);

		const totalArea = width * height;
		const minArea = totalArea * 0.003;
		const maxArea = totalArea * 0.25;

		// Reused across crops so we don't re-allocate two canvases per note on
		// boards with 30+ stickies.
		const colorCanvas = new OffscreenCanvas(1, 1);
		const ocrCanvas = new OffscreenCanvas(1, 1);

		for (let i = 0; i < contours.size(); i++) {
			const cnt = contours.get(i);
			const area = cv.contourArea(cnt);
			if (area < minArea || area > maxArea) {
				cnt.delete();
				continue;
			}

			// Convex hull eats peeled-corner concavities — a sticky whose
			// bottom-right has curled away from the wall would otherwise have
			// a C-shaped contour that throws off both rotated-rect fit and
			// the eventual crop. The hull's area is also slightly bigger
			// than the contour, which can rescue notes that fell just below
			// minArea for the same reason.
			const hull = new cv.Mat();
			cv.convexHull(cnt, hull, false, true);

			const rotRect = cv.minAreaRect(hull);
			const rect = cv.boundingRect(cnt);
			cnt.delete();
			hull.delete();

			// Aspect filter using the rotated rect's true long/short sides.
			// boundingRect would inflate aspect on tilted notes (a 1:1 note
			// rotated 30° has a bbox aspect of ~1.4 just from the rotation).
			const longSide = Math.max(rotRect.size.width, rotRect.size.height);
			const shortSide = Math.min(rotRect.size.width, rotRect.size.height);
			if (shortSide < 1) continue;
			const aspect = longSide / shortSide;
			if (aspect > 2.2) continue;

			// Color sampling — still done on the axis-aligned ROI of `src`.
			// cvtColor + mean handle stepped ROIs natively (they go through
			// OpenCV's pixel-access path, not the raw .data buffer).
			const cropRoi = src.roi(rect);
			const cx = Math.floor(rect.width * 0.25);
			const cy = Math.floor(rect.height * 0.25);
			const cw = Math.max(1, Math.floor(rect.width * 0.5));
			const ch = Math.max(1, Math.floor(rect.height * 0.5));
			const center = cropRoi.roi(new cv.Rect(cx, cy, cw, ch));
			const centerRgb = new cv.Mat();
			const centerHsv = new cv.Mat();
			cv.cvtColor(center, centerRgb, cv.COLOR_RGBA2RGB);
			cv.cvtColor(centerRgb, centerHsv, cv.COLOR_RGB2HSV);
			const meanHsv = cv.mean(centerHsv) as [number, number, number, number];
			const meanRgb = cv.mean(centerRgb) as [number, number, number, number];
			const [hVal, sVal, vVal] = meanHsv;
			const hex = rgbToHex(meanRgb[0], meanRgb[1], meanRgb[2]);
			cropRoi.delete();
			center.delete();
			centerRgb.delete();
			centerHsv.delete();

			// ----- Layer 2: deskew via canvas affine -----
			//
			// Pick whichever of the rotated rect's two perpendicular axes
			// requires the SMALLEST rotation to snap to image-axis-aligned,
			// and use that as our rotation amount. This preserves each
			// sticky's natural orientation (portrait vs landscape) instead
			// of always forcing the long side horizontal — which would
			// 90°-flip portrait notes and present their text sideways to
			// OCR. For nearly-square notes it also stops minAreaRect's
			// width/height labeling from randomly flipping us between runs
			// based on contour noise.
			//
			// Caveat: we assume the photo is taken roughly upright (sticky
			// tilted by ≤ ~45°). A sticky at 60°+ in the image gets the
			// same "smallest rotation" applied, which would still leave it
			// sideways. Tesseract's PSM_AUTO_OSD could detect 90°/180°
			// orientations but that's heavier and not needed for typical
			// hand-held whiteboard photos.
			const cxC = rotRect.center.x;
			const cyC = rotRect.center.y;
			const a = (rotRect.angle * Math.PI) / 180;

			// Two perpendicular axis orientations in image space. The
			// rect's "width" axis points at angle `a`; its "height" axis
			// is +90° from that.
			const widthAxisAngle = a;
			const heightAxisAngle = a + Math.PI / 2;

			// Normalize to (-π/2, π/2] — line orientations differing by π
			// describe the same line, so we keep the representative with
			// the smaller magnitude.
			const normWidth = normalizeLineAngle(widthAxisAngle);
			const normHeight = normalizeLineAngle(heightAxisAngle);

			let chosenAngleRad: number;
			let outW: number;
			let outH: number;
			if (Math.abs(normWidth) <= Math.abs(normHeight)) {
				// Snap the rect's width-axis horizontal. Output dimensions
				// match the rect's natural (width, height) labeling.
				chosenAngleRad = normWidth;
				outW = Math.max(1, Math.round(rotRect.size.width));
				outH = Math.max(1, Math.round(rotRect.size.height));
			} else {
				// Snap the rect's height-axis horizontal. The output's
				// horizontal axis now corresponds to what OpenCV called
				// the rect's "height".
				chosenAngleRad = normHeight;
				outW = Math.max(1, Math.round(rotRect.size.height));
				outH = Math.max(1, Math.round(rotRect.size.width));
			}

			colorCanvas.width = outW;
			colorCanvas.height = outH;
			const colorCtx = colorCanvas.getContext("2d");
			if (!colorCtx) throw new Error("color canvas ctx unavailable");
			// Transform stack reads bottom-up: translate so the rotated
			// rect's center sits at the canvas's origin, rotate by minus
			// the chosen tilt to undo it, then translate so that origin
			// maps to the dest canvas's center. The visible canvas region
			// is exactly the (small) deskew of the original rect.
			colorCtx.save();
			colorCtx.translate(outW / 2, outH / 2);
			colorCtx.rotate(-chosenAngleRad);
			colorCtx.translate(-cxC, -cyC);
			colorCtx.drawImage(off, 0, 0);
			colorCtx.restore();

			const colorImgData = colorCtx.getImageData(0, 0, outW, outH);
			const colorBlob = await colorCanvas.convertToBlob({ type: "image/png" });
			const cropDataUrl = await blobToDataUrl(colorBlob);

			// ----- Layer 1: preprocess for OCR -----
			//
			// On the deskewed color crop, run grayscale → CLAHE → adaptive
			// threshold → 2× upscale. Tesseract expects ~300 DPI and clean
			// binarized text; sticky-note crops at our 1280px working
			// resolution are well below that, and CLAHE+threshold both fix
			// uneven lighting and amplify pen strokes.
			const colorMat = cv.matFromImageData(colorImgData);
			const grayMat = new cv.Mat();
			cv.cvtColor(colorMat, grayMat, cv.COLOR_RGBA2GRAY);

			const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
			clahe.apply(grayMat, grayMat);

			const threshMat = new cv.Mat();
			// Block size 31, C=10: tuned defaults from the OCR-preprocessing
			// literature for sticky-note-sized crops. Larger blocks oversmooth
			// thin pen strokes; smaller blocks pick up paper texture as noise.
			cv.adaptiveThreshold(
				grayMat,
				threshMat,
				255,
				cv.ADAPTIVE_THRESH_GAUSSIAN_C,
				cv.THRESH_BINARY,
				31,
				10,
			);

			const upMat = new cv.Mat();
			cv.resize(
				threshMat,
				upMat,
				new cv.Size(0, 0),
				2,
				2,
				cv.INTER_CUBIC,
			);

			const ocrRgba = new cv.Mat();
			cv.cvtColor(upMat, ocrRgba, cv.COLOR_GRAY2RGBA);

			ocrCanvas.width = ocrRgba.cols;
			ocrCanvas.height = ocrRgba.rows;
			const ocrCtx = ocrCanvas.getContext("2d");
			if (!ocrCtx) throw new Error("ocr canvas ctx unavailable");
			ocrCtx.putImageData(matToImageData(ocrRgba), 0, 0);
			const ocrBlob = await ocrCanvas.convertToBlob({ type: "image/png" });
			const ocrDataUrl = await blobToDataUrl(ocrBlob);

			colorMat.delete();
			grayMat.delete();
			clahe.delete();
			threshMat.delete();
			upMat.delete();
			ocrRgba.delete();

			results.push({
				bbox: {
					x: Math.round(rect.x / scale),
					y: Math.round(rect.y / scale),
					w: Math.round(rect.width / scale),
					h: Math.round(rect.height / scale),
				},
				cropDataUrl,
				ocrDataUrl,
				color: { h: hVal, s: sVal, v: vVal, hex, bucket: hueToBucket(hVal, sVal, vVal) },
			});
		}
	} finally {
		for (const m of disposables) {
			try {
				m.delete();
			} catch {
				/* already deleted */
			}
		}
	}

	const rowBand = Math.max(1, Math.round(height / scale / 12));
	results.sort((a, b) => {
		const rowA = Math.floor(a.bbox.y / rowBand);
		const rowB = Math.floor(b.bbox.y / rowBand);
		if (rowA !== rowB) return rowA - rowB;
		return a.bbox.x - b.bbox.x;
	});

	return results;
}

function hueToBucket(h: number, s: number, v: number): ColorBucket {
	if (s < 50 || v < 70) return "other";
	if (h < 8 || h >= 165) return "pink";
	if (h < 20) return "orange";
	if (h < 35) return "yellow";
	if (h < 85) return "green";
	if (h < 130) return "blue";
	if (h < 165) return "purple";
	return "other";
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Normalize a line orientation to (-π/2, π/2]. Two angles differing by π
 * describe the same line; this returns the representative with the
 * smallest absolute value. Used to pick which of a rotated rect's two
 * perpendicular axes is closest to image-axis-aligned, so we can rotate
 * by the minimum amount needed to deskew (instead of always forcing the
 * long side horizontal).
 */
function normalizeLineAngle(a: number): number {
	let n = a % Math.PI;
	if (n > Math.PI / 2) n -= Math.PI;
	else if (n <= -Math.PI / 2) n += Math.PI;
	return n;
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result === "string") resolve(result);
			else reject(new Error("FileReader returned non-string"));
		};
		reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
		reader.readAsDataURL(blob);
	});
}

/**
 * Convert an OpenCV.js Mat into an ImageData, accounting for the Mat's row
 * stride. Critical because opencv.js Mats may have step > cols * elemSize
 * (alignment padding for SIMD), and a naive `new Uint8ClampedArray(mat.data)`
 * copy would drag those padding bytes into the visible image, producing the
 * "each row pushed left/right" glitch we saw earlier.
 *
 * Always returns RGBA. If the input Mat is 1- or 3-channel, we cvtColor it
 * to RGBA first inside the helper. The caller doesn't need to convert.
 */
function matToImageData(mat: any): ImageData {
	let rgba = mat;
	let needsDelete = false;
	const channels = mat.channels();
	if (channels === 1) {
		rgba = new cv.Mat();
		cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
		needsDelete = true;
	} else if (channels === 3) {
		rgba = new cv.Mat();
		cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
		needsDelete = true;
	}

	const cols = rgba.cols;
	const rows = rgba.rows;
	const expectedRowBytes = cols * 4;

	// Probe the actual byte length of mat.data and infer step. opencv.js
	// exposes the data getter as a HEAPU8 subarray sized rows*step, so when
	// step has padding the total length is bigger than rows*cols*4.
	const src: Uint8Array = rgba.data;
	const dataLen = src.length;
	let stepBytes = expectedRowBytes;
	if (dataLen >= rows * expectedRowBytes && dataLen % rows === 0) {
		const inferred = dataLen / rows;
		if (inferred >= expectedRowBytes) stepBytes = inferred;
	}

	let result: ImageData;
	if (stepBytes === expectedRowBytes) {
		// Fast path: no padding. A single subarray + clamped copy.
		const slice = src.subarray(0, rows * expectedRowBytes);
		result = new ImageData(new Uint8ClampedArray(slice), cols, rows);
	} else {
		// Padded: copy each row's pixel bytes (skipping the padding tail).
		const dst = new Uint8ClampedArray(rows * expectedRowBytes);
		for (let y = 0; y < rows; y++) {
			const srcOff = y * stepBytes;
			dst.set(
				src.subarray(srcOff, srcOff + expectedRowBytes),
				y * expectedRowBytes,
			);
		}
		result = new ImageData(dst, cols, rows);
	}

	if (needsDelete) rgba.delete();
	return result;
}

export type {};
export type { OutgoingMessage };
