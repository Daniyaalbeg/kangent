/// <reference lib="webworker" />

// Vision worker — runs the OpenCV.js detection pipeline off the main thread.
//
// Why this is a worker (not a module the main thread loads directly):
// - @techstark/opencv-js is ~10 MB of JS + wasm. Compiling it on the main
//   thread blocks the renderer for several seconds and, combined with the
//   memory pressure from a freshly-decoded multi-megapixel ImageBitmap,
//   was reliably crashing Chrome's renderer process during smoke testing.
// - The Tesseract worker also wants the network and main thread during its
//   own boot. Running CV on a separate thread frees both up so they can
//   load truly in parallel.
// - We do *all* CV work here (downscale, mask, contour, crop, color sample,
//   PNG encoding) so the main thread receives only finished `DetectedSticky`
//   records — no Mat objects ever leak out, no canvas operations happen on
//   the main UI thread.
//
// Protocol:
//   in:  { id, type: "detect", bitmap, maxLongEdge }   (bitmap is transferred)
//   out: { id, type: "detected", stickies }
//        | { id, type: "error", error }

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

// OpenCV's wasm runtime initializes asynchronously after the JS module
// evaluates. We expose a single promise so concurrent detect() calls during
// startup all await the same init.
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
		// Free the GPU-backed bitmap explicitly. ImageBitmap's pixel storage
		// often lives outside the JS heap so leaving it for GC can keep big
		// allocations alive longer than expected.
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
	// Downscale via OffscreenCanvas. Working-resolution math: a 1280px long
	// edge keeps masks at ~3.7 MB per channel — comfortably below the wasm
	// memory ceiling, while still detecting sticky notes that are >0.3% of
	// the photo area (i.e. anything bigger than a thumbnail).
	const longEdge = Math.max(bitmap.width, bitmap.height);
	const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);

	const off = new OffscreenCanvas(width, height);
	const ctx = off.getContext("2d");
	if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
	ctx.drawImage(bitmap, 0, 0, width, height);
	// We grab ImageData and feed it to OpenCV via matFromImageData. This is
	// the only input path that works in a worker — `cv.imread` expects a
	// DOM canvas, which workers don't have.
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

		// Saturation > 60 drops the white whiteboard surface; Value > 60 drops
		// black shadow blobs. Hue is unrestricted so any sticky-note color
		// passes through. Tune these floors if real-world photos under-detect.
		const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 60, 60, 0]);
		const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
			180, 255, 255, 255,
		]);
		disposables.push(lower, upper);
		cv.inRange(hsv, lower, upper, mask);

		// Closing fills small text-stroke gaps inside notes (handwriting on a
		// yellow sticky leaves dark trails that fragment contours otherwise);
		// opening then strips pinhead noise. Kernel size scales with input
		// width so the same proportions apply at different resolutions.
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

		// Encoder canvases are reused across crops. Re-instantiating an
		// OffscreenCanvas + 2D context per note adds noticeable overhead on
		// boards with 30+ stickies.
		const encoderCanvas = new OffscreenCanvas(1, 1);

		for (let i = 0; i < contours.size(); i++) {
			const cnt = contours.get(i);
			const area = cv.contourArea(cnt);
			if (area < minArea || area > maxArea) {
				cnt.delete();
				continue;
			}

			const rect = cv.boundingRect(cnt);
			cnt.delete();

			const aspect = rect.width / rect.height;
			if (aspect < 0.5 || aspect > 2.2) continue;

			// Color sampling: an ROI on the parent Mat is fine here because
			// `cv.cvtColor` and `cv.mean` use OpenCV's internal pixel-access
			// path that respects `step` correctly. The trouble was only with
			// reading raw bytes out of a Mat's `.data` getter — opencv.js
			// returns a Uint8Array view into HEAPU8 whose layout we can't
			// safely interpret as a contiguous RGBA block.
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
			const [h, s, v] = meanHsv;
			const hex = rgbToHex(meanRgb[0], meanRgb[1], meanRgb[2]);

			// Crop encoding: bypass OpenCV entirely. We already have the
			// downscaled image in `off` (the OffscreenCanvas). drawImage with
			// a source rect is a native browser API that doesn't care about
			// any of OpenCV's stride/contiguity weirdness — it just copies
			// the pixels from `off` to the encoder canvas correctly. This
			// fixes the glitchy/sheared thumbnails that came from trying to
			// reinterpret a stepped Mat's bytes as a flat RGBA block.
			encoderCanvas.width = rect.width;
			encoderCanvas.height = rect.height;
			const encCtx = encoderCanvas.getContext("2d");
			if (!encCtx) throw new Error("crop encoder 2D context unavailable");
			encCtx.drawImage(
				off,
				rect.x,
				rect.y,
				rect.width,
				rect.height,
				0,
				0,
				rect.width,
				rect.height,
			);
			const blob = await encoderCanvas.convertToBlob({ type: "image/png" });
			const cropDataUrl = await blobToDataUrl(blob);

			results.push({
				bbox: {
					x: Math.round(rect.x / scale),
					y: Math.round(rect.y / scale),
					w: Math.round(rect.width / scale),
					h: Math.round(rect.height / scale),
				},
				cropDataUrl,
				color: { h, s, v, hex, bucket: hueToBucket(h, s, v) },
			});

			cropRoi.delete();
			center.delete();
			centerRgb.delete();
			centerHsv.delete();
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

	// Sort whiteboard reading order: row band then x. The band keeps notes
	// at roughly the same y in the same row even if they're a few pixels off.
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
	// OpenCV hue is 0–179 (full circle / 2). Reds wrap at both ends.
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

export type {};
export type { OutgoingMessage };
