// OCR per detected sticky note via Tesseract.js.
//
// We keep one long-lived Tesseract worker for the whole import session.
// Workers are expensive to spin up (downloads eng.traineddata, ~10 MB the
// first time, then IndexedDB-cached) so creating per-note would be insane.
// We do hand it images one at a time though — Tesseract is single-threaded
// per worker, and parallelizing means firing up multiple workers and paying
// the init cost each.

import { createWorker, type Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;

export interface OcrProgress {
	/** Tesseract status string, e.g. "loading tesseract core", "recognizing text". */
	status: string;
	/** 0–1 within the current status phase (not overall). */
	progress: number;
}

/** Lazy-create a singleton Tesseract worker. The first call kicks off the
 * download of core wasm + the English model (`eng.traineddata`) which adds
 * ~10 MB on first ever use; subsequent loads hit the browser cache. */
export function ensureOcrWorker(
	onProgress?: (p: OcrProgress) => void,
): Promise<Worker> {
	if (workerPromise) return workerPromise;
	workerPromise = (async () => {
		// Tesseract.js v6+ no longer accepts the logger via `createWorker(lang,
		// oem, options)` — pass it through options. Status messages we care
		// about: "loading tesseract core", "loading language traineddata",
		// "initializing api", "recognizing text".
		const worker = await createWorker("eng", 1, {
			logger: onProgress
				? (m: { status: string; progress?: number }) =>
						onProgress({ status: m.status, progress: m.progress ?? 0 })
				: undefined,
		});
		return worker;
	})();
	return workerPromise;
}

/** Recognize text in a single sticky-note crop. Accepts a data URL, a Blob,
 * a canvas, or anything else Tesseract.js accepts. */
export async function recognizeText(
	image: string | HTMLCanvasElement | Blob | ImageData,
): Promise<string> {
	const worker = await ensureOcrWorker();
	// Tesseract's TS types are loose; cast to any to avoid the union dance.
	const result = await worker.recognize(image as any);
	return cleanOcrText(result.data.text);
}

/** Tesseract output for handwriting is messy: trailing newlines, sprinkled
 * single-character "noise" lines, occasional all-whitespace lines. This
 * trims the obvious junk so a usable card title falls out. */
function cleanOcrText(raw: string): string {
	if (!raw) return "";
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		// Drop lines that are mostly punctuation/garbage (≥ 60% non-alphanumeric).
		.filter((line) => {
			if (line.length < 2) return false;
			const alphanumCount = line.replace(/[^a-zA-Z0-9]/g, "").length;
			return alphanumCount / line.length >= 0.4;
		});
	return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** Tear down the worker — call when the import dialog closes so we don't
 * keep ~30 MB of wasm + model alive. */
export async function terminateOcrWorker(): Promise<void> {
	if (!workerPromise) return;
	const wp = workerPromise;
	workerPromise = null;
	try {
		const worker = await wp;
		await worker.terminate();
	} catch {
		/* worker already gone */
	}
}
