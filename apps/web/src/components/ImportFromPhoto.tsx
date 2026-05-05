// "Import from photo" dialog.
//
// Pipeline:
//   1) user picks a photo (file picker; on mobile this triggers camera).
//   2) we lazy-load OpenCV.js, downscale + run sticky-note detection.
//   3) we lazy-load Tesseract.js and OCR each crop sequentially. Each note's
//      title field starts as "..." and resolves as OCR completes — the user
//      can already start editing earlier notes while later ones are reading.
//   4) user edits / re-buckets / removes rows, hits "Import" → fans out
//      addCard calls with a small concurrency limit so the DO isn't slammed.
//
// Loading strategy: the heavy deps (`@techstark/opencv-js` ~7 MB, the
// Tesseract worker + `eng.traineddata` ~12 MB combined) are dynamic-imported
// inside the lazy modules — they only land in the bundle for users who open
// this dialog.

import { useEffect, useId, useRef, useState } from "react";
import {
	bucketLabel,
	suggestColumnForColor,
} from "~/lib/sticky-vision/columns";
import {
	type DetectedSticky,
	detectStickies,
	drawBitmapToCanvas,
	ensureOpenCv,
	fileToBitmap,
} from "~/lib/sticky-vision/detect";
import {
	type OcrProgress,
	ensureOcrWorker,
	recognizeText,
	terminateOcrWorker,
} from "~/lib/sticky-vision/ocr";
import {
	ActionsRow,
	DetailBody,
	DetailFooter,
	DetailModal,
	MetaLabelSpan,
	PrimaryButton,
	TextAction,
	scrollbarThinClass,
} from "./ui";

interface ColumnRef {
	id: string;
	title: string;
}

interface ImportFromPhotoProps {
	columns: readonly ColumnRef[];
	onClose: () => void;
	/** Called once per imported card. The parent fires the actual `addCard`
	 * RPC; the dialog itself stays agnostic about the network layer. */
	onImport: (card: { columnId: string; title: string }) => void;
}

type Stage =
	| { kind: "idle" }
	| { kind: "loading-cv"; message: string }
	| { kind: "detecting" }
	| { kind: "reviewing" } // detected, OCR may still be running per-row
	| { kind: "error"; message: string };

interface RowState {
	id: string;
	sticky: DetectedSticky;
	title: string;
	columnId: string;
	ocrStatus: "pending" | "running" | "done" | "failed";
	included: boolean;
}

const MAX_PARALLEL_IMPORTS = 4;

export function ImportFromPhoto({
	columns,
	onClose,
	onImport,
}: ImportFromPhotoProps) {
	const fileInputId = useId();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [stage, setStage] = useState<Stage>({ kind: "idle" });
	const [rows, setRows] = useState<RowState[]>([]);
	const [importing, setImporting] = useState(false);
	// Used to ignore stale async results if the user opens a 2nd photo while
	// the 1st is still being processed.
	const runIdRef = useRef(0);

	useEffect(() => {
		// On unmount: tear down the OCR worker and free its wasm/model memory.
		// Not strictly required (browser will GC eventually) but ~30 MB is
		// worth releasing when the dialog closes.
		return () => {
			void terminateOcrWorker();
		};
	}, []);

	const handleFile = async (file: File | null) => {
		if (!file) return;
		const myRun = ++runIdRef.current;
		setRows([]);
		setStage({ kind: "loading-cv", message: "Loading vision engine..." });

		try {
			// Kick off both heavy loads in parallel: OpenCV is needed before
			// detection, but Tesseract can warm up alongside it so by the time
			// detection finishes the OCR worker is already booted.
			const cvPromise = ensureOpenCv();
			const ocrPromise = ensureOcrWorker((p: OcrProgress) => {
				if (myRun !== runIdRef.current) return;
				setStage((current) =>
					current.kind === "loading-cv"
						? { kind: "loading-cv", message: ocrStatusToMessage(p) }
						: current,
				);
			});

			const bitmap = await fileToBitmap(file);
			await cvPromise;
			if (myRun !== runIdRef.current) return;

			setStage({ kind: "detecting" });
			const { canvas, scale } = drawBitmapToCanvas(bitmap);
			const stickies = await detectStickies(canvas, scale);
			if (myRun !== runIdRef.current) return;

			if (stickies.length === 0) {
				setStage({
					kind: "error",
					message:
						"No sticky notes detected. Try a sharper photo with more contrast against the background.",
				});
				return;
			}

			// Seed rows immediately so the user sees thumbnails + suggested
			// columns; OCR fills in titles asynchronously below.
			const initialRows: RowState[] = stickies.map((sticky, i) => ({
				id: `row-${i}`,
				sticky,
				title: "",
				columnId:
					suggestColumnForColor(sticky.color.bucket, columns) ??
					columns[0]?.id ??
					"",
				ocrStatus: "pending",
				included: true,
			}));
			setRows(initialRows);
			setStage({ kind: "reviewing" });

			await ocrPromise;
			if (myRun !== runIdRef.current) return;

			// OCR sequentially. Tesseract is single-threaded per worker so
			// parallel calls just queue inside the worker anyway; doing it
			// explicitly lets us update the UI as each completes.
			for (const row of initialRows) {
				if (myRun !== runIdRef.current) return;
				setRows((prev) =>
					prev.map((r) =>
						r.id === row.id ? { ...r, ocrStatus: "running" } : r,
					),
				);
				try {
					const text = await recognizeText(row.sticky.cropDataUrl);
					if (myRun !== runIdRef.current) return;
					setRows((prev) =>
						prev.map((r) =>
							r.id === row.id
								? {
										...r,
										title: text || r.title,
										ocrStatus: "done",
									}
								: r,
						),
					);
				} catch {
					if (myRun !== runIdRef.current) return;
					setRows((prev) =>
						prev.map((r) =>
							r.id === row.id ? { ...r, ocrStatus: "failed" } : r,
						),
					);
				}
			}
		} catch (err) {
			if (myRun !== runIdRef.current) return;
			setStage({
				kind: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const handleImport = async () => {
		const toImport = rows.filter(
			(r) => r.included && r.title.trim() && r.columnId,
		);
		if (toImport.length === 0) return;
		setImporting(true);

		// Bounded-concurrency dispatcher. We can't await `onImport` itself
		// since the parent fires-and-forgets via `agent.call`, but pacing the
		// fan-out still helps avoid bursts that would create N changelog
		// entries in the same RTT and stress the DO.
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(MAX_PARALLEL_IMPORTS, toImport.length) }).map(
				async () => {
					while (cursor < toImport.length) {
						const i = cursor++;
						const row = toImport[i];
						if (!row) continue;
						onImport({ columnId: row.columnId, title: row.title.trim() });
						// Small breather so successive RPCs don't all fire on the
						// same microtask tick. 30 ms is imperceptible to the user
						// but lets the DO interleave each insert with its writes.
						await new Promise((r) => setTimeout(r, 30));
					}
				},
			),
		);
		setImporting(false);
		onClose();
	};

	const removeRow = (id: string) =>
		setRows((prev) => prev.filter((r) => r.id !== id));
	const updateRow = (id: string, patch: Partial<RowState>) =>
		setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

	const includedCount = rows.filter((r) => r.included && r.title.trim()).length;

	return (
		<DetailModal onClose={onClose}>
			<DetailBody>
				<div className="flex flex-col gap-5">
					<div className="flex flex-col gap-1">
						<MetaLabelSpan>Import from photo</MetaLabelSpan>
						<h2 className="m-0 font-serif font-medium text-2xl leading-[1.2]">
							Sticky notes → cards
						</h2>
						<p className="m-0 text-sm leading-[1.45] text-text-muted">
							Snap or upload a photo of a whiteboard. We detect each note's
							color, read its text, and queue them as cards for you to review.
						</p>
					</div>

					{stage.kind === "idle" && (
						<>
							<input
								ref={fileInputRef}
								id={fileInputId}
								type="file"
								accept="image/*"
								capture="environment"
								className="sr-only"
								onChange={(e) => {
									const file = e.target.files?.[0] ?? null;
									void handleFile(file);
								}}
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								className="flex flex-col items-center justify-center gap-2 min-h-[180px] rounded-xl bg-surface-muted text-text-muted ring-1 ring-inset ring-border-soft transition-colors hover:bg-surface-muted/70"
							>
								<span className="text-2xl">📷</span>
								<span className="text-[15px] leading-[22px]">
									Tap to take a photo or pick a file
								</span>
								<span className="text-xs text-text-subtle">
									JPEG / PNG · works best on a clean whiteboard
								</span>
							</button>
						</>
					)}

					{stage.kind === "loading-cv" && (
						<StatusPanel message={stage.message} />
					)}
					{stage.kind === "detecting" && (
						<StatusPanel message="Detecting sticky notes..." />
					)}

					{stage.kind === "error" && (
						<div className="flex flex-col gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--color-danger)_8%,white)] text-danger ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-danger)_30%,white)]">
							<p className="m-0 text-sm leading-[1.45]">{stage.message}</p>
							<TextAction
								onClick={() => {
									setStage({ kind: "idle" });
									setRows([]);
								}}
							>
								Try another photo
							</TextAction>
						</div>
					)}

					{stage.kind === "reviewing" && rows.length > 0 && (
						<div className={`flex flex-col gap-3 max-h-[50vh] overflow-y-auto ${scrollbarThinClass}`}>
							{rows.map((row) => (
								<RowEditor
									key={row.id}
									row={row}
									columns={columns}
									onChange={(patch) => updateRow(row.id, patch)}
									onRemove={() => removeRow(row.id)}
								/>
							))}
						</div>
					)}
				</div>
			</DetailBody>
			<DetailFooter>
				<ActionsRow className="w-full justify-end">
					<TextAction onClick={onClose} disabled={importing}>
						Cancel
					</TextAction>
					{stage.kind === "reviewing" && (
						<PrimaryButton
							label={
								importing
									? "Importing..."
									: `Import ${includedCount} card${includedCount === 1 ? "" : "s"}`
							}
							onClick={handleImport}
							disabled={importing || includedCount === 0}
						/>
					)}
				</ActionsRow>
			</DetailFooter>
		</DetailModal>
	);
}

function StatusPanel({ message }: { message: string }) {
	return (
		<div className="flex items-center gap-3 p-4 rounded-lg bg-surface-muted text-text-secondary ring-1 ring-inset ring-border-soft">
			<span
				aria-hidden="true"
				className="inline-block w-3 h-3 rounded-full bg-accent animate-pulse"
			/>
			<span className="text-sm leading-[1.45]">{message}</span>
		</div>
	);
}

function RowEditor({
	row,
	columns,
	onChange,
	onRemove,
}: {
	row: RowState;
	columns: readonly ColumnRef[];
	onChange: (patch: Partial<RowState>) => void;
	onRemove: () => void;
}) {
	const ocrLabel =
		row.ocrStatus === "running"
			? "reading…"
			: row.ocrStatus === "pending"
				? "queued"
				: row.ocrStatus === "failed"
					? "ocr failed"
					: "";

	return (
		<div
			className={`flex items-start gap-3 p-3 rounded-lg bg-surface ring-1 ring-inset ring-border-soft ${
				row.included ? "" : "opacity-50"
			}`}
		>
			<img
				src={row.sticky.cropDataUrl}
				alt=""
				className="w-16 h-16 object-cover rounded-md ring-1 ring-inset ring-border-soft shrink-0"
			/>
			<div className="flex-1 flex flex-col gap-2 min-w-0">
				<div className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className="inline-block w-3 h-3 rounded-full ring-1 ring-inset ring-border-soft"
						style={{ backgroundColor: row.sticky.color.hex }}
						title={row.sticky.color.hex}
					/>
					<MetaLabelSpan>{bucketLabel(row.sticky.color.bucket)}</MetaLabelSpan>
					{ocrLabel && (
						<span className="text-xs leading-4 text-text-subtle">
							· {ocrLabel}
						</span>
					)}
				</div>
				<input
					type="text"
					value={row.title}
					placeholder={
						row.ocrStatus === "running" || row.ocrStatus === "pending"
							? "Reading text…"
							: "Card title"
					}
					onChange={(e) => onChange({ title: e.target.value })}
					className="w-full px-3 py-2 border border-border rounded-[10px] bg-[#fbfbfc] text-text-primary outline-none focus:border-accent text-[15px] leading-[22px]"
				/>
				<div className="flex items-center justify-between gap-2">
					<select
						value={row.columnId}
						onChange={(e) => onChange({ columnId: e.target.value })}
						className="px-2 py-1 border border-border rounded-md bg-surface text-text-secondary text-xs leading-4 outline-none focus:border-accent"
					>
						{columns.map((col) => (
							<option key={col.id} value={col.id}>
								{col.title}
							</option>
						))}
					</select>
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-1 text-xs leading-4 text-text-muted cursor-pointer">
							<input
								type="checkbox"
								checked={row.included}
								onChange={(e) => onChange({ included: e.target.checked })}
							/>
							include
						</label>
						<TextAction onClick={onRemove}>remove</TextAction>
					</div>
				</div>
			</div>
		</div>
	);
}

function ocrStatusToMessage(p: OcrProgress): string {
	switch (p.status) {
		case "loading tesseract core":
		case "initialize tesseract":
			return "Loading OCR engine...";
		case "loading language traineddata":
		case "loading language traineddata (from cache)":
			return "Loading English model...";
		case "initializing api":
			return "Warming up...";
		case "initialized api":
			return "OCR ready.";
		case "recognizing text":
			return `Reading text... ${Math.round(p.progress * 100)}%`;
		default:
			return p.status ? p.status.charAt(0).toUpperCase() + p.status.slice(1) : "Loading...";
	}
}
