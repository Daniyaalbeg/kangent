// Sticky-note detection via classical CV (OpenCV.js).
//
// Why classical CV instead of a learned object detector:
// - Sticky notes are highly saturated rectangles on a near-white background.
//   That's a textbook segmentation problem — no model weights needed.
// - We avoid shipping a custom-trained YOLO and a 6+MB weights file when
//   `cv.findContours` does the same job in a few hundred ms with no labels.
//
// The pipeline:
//   1) downscale to a sane working resolution (4K phone photos are wasteful)
//   2) HSV mask — keep saturated regions, drop near-white background + shadows
//   3) morphological close/open to consolidate each note's region
//   4) findContours → boundingRect, filter by area + aspect ratio
//   5) crop each note, sample its center HSV → bucket to a column color

export type ColorBucket =
	| "yellow"
	| "pink"
	| "blue"
	| "green"
	| "orange"
	| "purple"
	| "other";

export interface DetectedSticky {
	/** Bounding box in the *original* image's coordinate space. */
	bbox: { x: number; y: number; w: number; h: number };
	/** PNG data URL of the cropped note, ready to feed Tesseract. */
	cropDataUrl: string;
	/** Median-ish color sampled from the center of the note. */
	color: {
		h: number; // 0–179 (OpenCV scale)
		s: number; // 0–255
		v: number; // 0–255
		hex: string;
		bucket: ColorBucket;
	};
}

// We dynamic-import OpenCV.js so it never lands in the main bundle. The wasm
// + JS glue is ~7 MB; the user only pays for it when they open the import
// dialog. The runtime initializes asynchronously, which is why this returns
// a promise rather than just the module.
let cvReadyPromise: Promise<any> | null = null;

export function ensureOpenCv(): Promise<any> {
	if (cvReadyPromise) return cvReadyPromise;
	cvReadyPromise = (async () => {
		const mod = await import("@techstark/opencv-js");
		const cv = (mod as any).default ?? mod;
		// If wasm is already initialized (e.g. HMR re-import), the `Mat`
		// constructor is present and we can return immediately.
		if (cv?.Mat) return cv;
		await new Promise<void>((resolve) => {
			cv.onRuntimeInitialized = () => resolve();
		});
		return cv;
	})();
	return cvReadyPromise;
}

/** Decode a `File` into an `ImageBitmap`. createImageBitmap auto-handles EXIF
 * orientation in all modern browsers, which means iPhone photos taken in
 * portrait won't come out sideways. */
export async function fileToBitmap(file: File): Promise<ImageBitmap> {
	return await createImageBitmap(file, { imageOrientation: "from-image" });
}

const MAX_LONG_EDGE = 1600; // working resolution for detection

/** Draw a bitmap onto a canvas, downscaling so its long edge ≤ MAX_LONG_EDGE.
 * Returns the canvas plus the scale factor we applied so callers can convert
 * working-space coords back to original-image coords. */
export function drawBitmapToCanvas(bitmap: ImageBitmap): {
	canvas: HTMLCanvasElement;
	scale: number;
} {
	const longEdge = Math.max(bitmap.width, bitmap.height);
	const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2D canvas context unavailable");
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return { canvas, scale };
}

/** Run the detection pipeline. `canvas` is the (possibly downscaled) working
 * image; `scale` is the factor used so we can return bbox coords in the
 * *original* image's coordinate space. */
export async function detectStickies(
	canvas: HTMLCanvasElement,
	scale = 1,
): Promise<DetectedSticky[]> {
	const cv = await ensureOpenCv();

	const src = cv.imread(canvas);
	const hsv = new cv.Mat();
	const mask = new cv.Mat();
	const contours = new cv.MatVector();
	const hierarchy = new cv.Mat();

	// Mat instances must be .delete()'d to free wasm memory. We collect them
	// in `disposables` and clean up in a finally so any throw mid-pipeline
	// doesn't leak.
	const disposables: any[] = [src, hsv, mask, contours, hierarchy];

	const results: DetectedSticky[] = [];

	try {
		// imread on RGBA canvas → 4-channel; convert to 3-channel HSV.
		const rgb = new cv.Mat();
		disposables.push(rgb);
		cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
		cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

		// Saturation > 60: drops white paper/whiteboard surface (low S).
		// Value > 60: drops black shadows under poor lighting.
		// We allow the full hue range so any sticky color qualifies.
		const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 60, 60, 0]);
		const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [
			180, 255, 255, 255,
		]);
		disposables.push(lower, upper);
		cv.inRange(hsv, lower, upper, mask);

		// Closing with a chunky kernel fills small text gaps inside notes
		// (writing on a yellow note is darker but still saturated; without
		// closing the contours fragment around the strokes). Opening then
		// nukes pinhead noise.
		const kSize = Math.max(7, Math.round(canvas.width / 200));
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

		const totalArea = canvas.width * canvas.height;
		// Sticky notes typically occupy 0.3%–25% of a whiteboard photo.
		// Tightening the floor too much kills tiny notes; loosening the
		// ceiling lets entire colored backgrounds slip in as a "note".
		const minArea = totalArea * 0.003;
		const maxArea = totalArea * 0.25;

		for (let i = 0; i < contours.size(); i++) {
			const cnt = contours.get(i);
			const area = cv.contourArea(cnt);
			if (area < minArea || area > maxArea) {
				cnt.delete();
				continue;
			}

			const rect = cv.boundingRect(cnt);
			cnt.delete();

			// Aspect ratio gate. Square sticky notes hover around 1.0; rectangular
			// ones don't usually exceed 2:1. Anything more elongated is probably
			// a marker stripe, table edge, or shadow strip that survived masking.
			const aspect = rect.width / rect.height;
			if (aspect < 0.5 || aspect > 2.2) continue;

			// Crop in working-image space.
			const cropMat = src.roi(rect);
			const cropCanvas = document.createElement("canvas");
			cropCanvas.width = rect.width;
			cropCanvas.height = rect.height;
			cv.imshow(cropCanvas, cropMat);

			// Sample the center 50% of the note for the dominant color. The
			// edges might catch the whiteboard rim or shadow; the center is
			// almost always paper + writing, and `cv.mean` over a moderate
			// area is robust enough that the writing's dark pixels don't shift
			// the bucket.
			const cx = Math.floor(rect.width * 0.25);
			const cy = Math.floor(rect.height * 0.25);
			const cw = Math.max(1, Math.floor(rect.width * 0.5));
			const ch = Math.max(1, Math.floor(rect.height * 0.5));
			const center = cropMat.roi(new cv.Rect(cx, cy, cw, ch));
			const centerRgb = new cv.Mat();
			const centerHsv = new cv.Mat();
			cv.cvtColor(center, centerRgb, cv.COLOR_RGBA2RGB);
			cv.cvtColor(centerRgb, centerHsv, cv.COLOR_RGB2HSV);
			const meanHsv = cv.mean(centerHsv);
			const meanRgb = cv.mean(centerRgb);
			const [h, s, v] = meanHsv as [number, number, number, number];
			const hex = rgbToHex(meanRgb[0], meanRgb[1], meanRgb[2]);

			results.push({
				bbox: {
					x: Math.round(rect.x / scale),
					y: Math.round(rect.y / scale),
					w: Math.round(rect.width / scale),
					h: Math.round(rect.height / scale),
				},
				cropDataUrl: cropCanvas.toDataURL("image/png"),
				color: { h, s, v, hex, bucket: hueToBucket(h, s, v) },
			});

			cropMat.delete();
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

	// Sort top-to-bottom, left-to-right (whiteboard reading order). We bucket
	// y to a row band first so notes that are roughly on the same row sort
	// by x, not by a 1-pixel y difference.
	const rowBand = Math.round(canvas.height / scale / 12);
	results.sort((a, b) => {
		const rowA = Math.floor(a.bbox.y / rowBand);
		const rowB = Math.floor(b.bbox.y / rowBand);
		if (rowA !== rowB) return rowA - rowB;
		return a.bbox.x - b.bbox.x;
	});

	return results;
}

function hueToBucket(h: number, s: number, v: number): ColorBucket {
	// Low saturation or low value → not a recognizable sticky color (could be
	// a piece of white paper, a shadow blob, etc).
	if (s < 50 || v < 70) return "other";
	// OpenCV hue is 0–179 (full circle / 2). Reds wrap at both ends.
	if (h < 8 || h >= 165) return "pink"; // pinks/reds
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
