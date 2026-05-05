// Public API of the sticky-vision detection layer.
//
// The actual OpenCV.js pipeline runs in a Web Worker (`vision.worker.ts`).
// The main thread only:
//   1) decodes the photo into an ImageBitmap (uses the browser's native
//      threaded decoder — does *not* block the renderer)
//   2) transfers the bitmap to the worker (zero-copy)
//   3) awaits the detection result
//
// This keeps the UI responsive during the multi-second cost of compiling
// OpenCV.js's wasm + running the pipeline on a multi-megapixel image, and
// isolates that workload's memory pressure from the page's renderer.

import VisionWorker from "./vision.worker?worker";

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
	/** PNG data URL of the cropped note. Same string is reused as both the
	 * `<img src>` for the review thumbnail and the input to Tesseract. */
	cropDataUrl: string;
	/** Color sampled from the center of the note (drops edge/shadow noise). */
	color: {
		h: number; // 0–179 (OpenCV hue scale)
		s: number; // 0–255
		v: number; // 0–255
		hex: string;
		bucket: ColorBucket;
	};
}

/** Working resolution upper bound. 1280px long edge keeps OpenCV mask Mats
 * around ~3.7 MB each — comfortably under the wasm memory ceiling — while
 * still detecting notes that occupy >0.3% of the photo. */
const DEFAULT_MAX_LONG_EDGE = 1280;

// Singleton worker. Spawning is what triggers the OpenCV.js download, so
// callers can call `ensureVisionWorker()` ahead of time to overlap that
// fetch with the user's other work (e.g. picking a file).
let workerInstance: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<
	number,
	{ resolve: (s: DetectedSticky[]) => void; reject: (e: Error) => void }
>();

function getVisionWorker(): Worker {
	if (workerInstance) return workerInstance;
	// Vite's `?worker` suffix imports a constructor that, when invoked,
	// spawns the bundled worker as a separate file with `type: "module"`.
	const worker = new VisionWorker();
	worker.addEventListener(
		"message",
		(event: MessageEvent<{
			id: number;
			type: "detected" | "error";
			stickies?: DetectedSticky[];
			error?: string;
		}>) => {
			const { id, type, stickies, error } = event.data;
			const handler = pending.get(id);
			if (!handler) return;
			pending.delete(id);
			if (type === "detected" && stickies) {
				handler.resolve(stickies);
			} else {
				handler.reject(new Error(error ?? "vision worker reported unknown error"));
			}
		},
	);
	worker.addEventListener("error", (event: ErrorEvent) => {
		// If the worker itself errors out (e.g. wasm compile failure), every
		// in-flight detect() should reject — otherwise the dialog would hang.
		const message = event.message || "vision worker crashed";
		for (const handler of pending.values()) handler.reject(new Error(message));
		pending.clear();
		// Drop the broken worker; the next detect() will spawn a fresh one.
		workerInstance = null;
	});
	workerInstance = worker;
	return worker;
}

/** Eager-spawn the vision worker so the OpenCV.js download starts as soon
 * as the user opens the import dialog, instead of waiting until they pick a
 * file. Cheap to call repeatedly — already-spawned worker is reused. */
export function ensureVisionWorker(): void {
	getVisionWorker();
}

/** Decode a `File` into an `ImageBitmap`. createImageBitmap honors EXIF
 * orientation in all modern browsers (so iPhone portrait photos come out
 * upright) and runs decoding off the main thread internally. */
export async function fileToBitmap(file: File): Promise<ImageBitmap> {
	return await createImageBitmap(file, { imageOrientation: "from-image" });
}

/** Run sticky-note detection on an ImageBitmap. The bitmap is *transferred*
 * into the worker (zero-copy) — after this call, the caller's ImageBitmap
 * reference is detached and no longer usable. */
export async function detectStickies(
	bitmap: ImageBitmap,
	maxLongEdge: number = DEFAULT_MAX_LONG_EDGE,
): Promise<DetectedSticky[]> {
	const worker = getVisionWorker();
	const id = ++nextRequestId;
	return new Promise<DetectedSticky[]>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		worker.postMessage(
			{ id, type: "detect", bitmap, maxLongEdge },
			[bitmap], // transferable
		);
	});
}

/** Tear down the worker — call when the import dialog closes so the OpenCV
 * wasm heap (~10 MB) is freed instead of lingering for the rest of the
 * session. Safe to call when no worker exists. */
export function terminateVisionWorker(): void {
	if (!workerInstance) return;
	workerInstance.terminate();
	workerInstance = null;
	// Reject anything still in flight — the user closed the dialog so they
	// don't care about results, and a stuck promise leaks the row state.
	for (const handler of pending.values()) {
		handler.reject(new Error("vision worker terminated"));
	}
	pending.clear();
}
