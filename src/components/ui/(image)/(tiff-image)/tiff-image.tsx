"use client";

import { memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTiffBytes } from "./use-tiff-bytes";
import { Spinner } from "@/components/ui/spinner";
import { lazy } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { decodeTiff } from "@/lib/tiff-worker-client";
import { TiffDecodeResponse } from "@/lib/tiff-worker.types";

// this is a huge import (from tiff.js), so lets lazy load it
const TiffImageInner = lazy(() => import("./tiff-image-inner"));

export const TiffImage = memo(function TiffImage({ src }: { src: string }) {
	const tiffBytes = useTiffBytes(src);
	const containerRef = useRef<HTMLDivElement>(null);

	const [tiffPromise, setTiffPromise] = useState<Promise<TiffDecodeResponse>>();
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const controller = new AbortController();
		let decoded = false;

		// The decode size comes from the container, so it waits for the container
		// to have one. Inside a dialog that animates in, the first measurement can
		// be zero, and a zero cap does not mean "do not decode"; it means "no
		// limit", which decodes the full picture. Once is enough: the result is
		// scaled to fit afterwards, so a later resize needs no second decode.
		const startDecode = () => {
			const width = container.clientWidth;
			const height = container.clientHeight;
			if (decoded || width === 0 || height === 0) return;
			decoded = true;
			observer.disconnect();

			const dpr = Math.max(1, window.devicePixelRatio || 1);
			const newPromise = tiffBytes.then((f) =>
				decodeTiff(f.buffer, {
					memoryBytes: f.buffer.byteLength * 2,
					maxWidth: Math.floor(width * dpr),
					maxHeight: Math.floor(height * dpr),
					signal: controller.signal,
				})
			);
			// The abort below is this effect's own cleanup, so the rejection it
			// causes is expected. Without a handler it surfaces as an unhandled
			// rejection for every remount.
			newPromise.catch(() => undefined);
			setTiffPromise(newPromise);
		};

		const observer = new ResizeObserver(startDecode);
		observer.observe(container);
		startDecode();

		return () => {
			observer.disconnect();
			controller.abort();
		};
		// containerRef.current is deliberately absent: a ref is not reactive, so
		// listing it only made the effect re-run once the ref went from null to
		// the element, cancelling the decode it had just started.
	}, [tiffBytes]);

	return (
		<div ref={containerRef} className="size-full">
			<ErrorBoundary errorPrefixMessage="Error loading TIFF image">
				<Suspense fallback={<Spinner />}>
					{tiffPromise && <TiffImageInner tiffPromise={tiffPromise} />}
				</Suspense>
			</ErrorBoundary>
		</div>
	);
});
