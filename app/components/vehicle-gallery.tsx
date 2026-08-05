"use client";

import { ChevronLeft, ChevronRight, Image as ImageIcon, Images, Maximize2, X } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { VehicleImage } from "./vehicle-image";

export type VehicleGalleryProps = {
  /** All official listing images, ordered with the preferred hero image first. */
  images: readonly (string | null | undefined)[];
  /** Human-readable vehicle name used by the dialog and image alternatives. */
  title: string;
  fallbackTitle: string;
  fallbackCopy: string;
  variant: "card" | "detail";
  priority?: boolean;
  className?: string;
  initialIndex?: number;
  /** Optional first-party endpoint used to load the complete official gallery on demand. */
  lazyGalleryUrl?: string;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function normalizedImages(images: VehicleGalleryProps["images"]) {
  const seen = new Set<string>();
  return images.flatMap((value) => {
    const source = value?.trim();
    if (!source || seen.has(source)) return [];
    seen.add(source);
    return [source];
  });
}

const MAX_CONCURRENT_GALLERY_REQUESTS = 4;

type QueuedGalleryRequest = {
  url: string;
  resolve: (images: string[]) => void;
  reject: (error: unknown) => void;
};

const galleryRequestCache = new Map<string, Promise<string[]>>();
const galleryRequestQueue: QueuedGalleryRequest[] = [];
let activeGalleryRequests = 0;

function officialImagesFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return [];
  const data = payload.data;
  if (!data || typeof data !== "object" || !("images" in data) || !Array.isArray(data.images)) {
    return [];
  }
  return normalizedImages(data.images.filter(
    (value): value is string => typeof value === "string" && /^https:\/\//i.test(value),
  ));
}

function drainGalleryRequestQueue() {
  while (
    activeGalleryRequests < MAX_CONCURRENT_GALLERY_REQUESTS &&
    galleryRequestQueue.length > 0
  ) {
    const request = galleryRequestQueue.shift();
    if (!request) return;
    activeGalleryRequests += 1;
    void fetch(request.url)
      .then((response) => {
        if (!response.ok) throw new Error(`Gallery returned ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((payload) => request.resolve(officialImagesFromPayload(payload)))
      .catch(request.reject)
      .finally(() => {
        activeGalleryRequests -= 1;
        drainGalleryRequestQueue();
      });
  }
}

function requestOfficialGallery(url: string): Promise<string[]> {
  const cached = galleryRequestCache.get(url);
  if (cached) return cached;

  const request = new Promise<string[]>((resolve, reject) => {
    galleryRequestQueue.push({ url, resolve, reject });
    drainGalleryRequestQueue();
  });
  galleryRequestCache.set(url, request);
  void request.catch(() => {
    if (galleryRequestCache.get(url) === request) galleryRequestCache.delete(url);
  });
  return request;
}

export function VehicleGallery({
  images,
  title,
  fallbackTitle,
  fallbackCopy,
  variant,
  priority = false,
  className,
  initialIndex = 0,
  lazyGalleryUrl,
}: VehicleGalleryProps) {
  const [lazyImages, setLazyImages] = useState<string[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [failedHeroImages, setFailedHeroImages] = useState<Set<string>>(() => new Set());
  const galleryAttemptedRef = useRef(false);
  const galleryRootRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const galleryImages = useMemo(
    () => normalizedImages([...images, ...lazyImages]).filter(
      (source) => !failedHeroImages.has(source),
    ),
    [failedHeroImages, images, lazyImages],
  );
  const boundedInitialIndex = Math.max(0, Math.min(initialIndex, galleryImages.length - 1));
  const [activeIndex, setActiveIndex] = useState(boundedInitialIndex);
  const [isOpen, setIsOpen] = useState(false);
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(() => new Set());
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const descriptionId = useId();

  const imageCount = galleryImages.length;
  const displayedIndex = Math.max(0, Math.min(activeIndex, imageCount - 1));
  const activeImage = galleryImages[displayedIndex] ?? galleryImages[0];
  const dialogOpen = isOpen && imageCount > 0;

  const closeGallery = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const previousImage = useCallback(() => {
    if (imageCount < 2) return;
    setActiveIndex((current) => (current - 1 + imageCount) % imageCount);
  }, [imageCount]);

  const nextImage = useCallback(() => {
    if (imageCount < 2) return;
    setActiveIndex((current) => (current + 1) % imageCount);
  }, [imageCount]);

  useEffect(() => {
    if (!dialogOpen) return;

    const body = document.body;
    const trigger = triggerRef.current;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);

    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      const currentPadding = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
    }

    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(focusFrame);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
      trigger?.focus();
    };
  }, [dialogOpen]);

  const loadLazyGallery = useCallback(() => {
    if (!lazyGalleryUrl || galleryAttemptedRef.current) return;
    galleryAttemptedRef.current = true;
    setGalleryLoading(true);
    void requestOfficialGallery(lazyGalleryUrl)
      .then((officialImages) => {
        if (mountedRef.current) setLazyImages(officialImages);
      })
      .catch(() => {
        // A later click can retry a transient source failure.
        galleryAttemptedRef.current = false;
      })
      .finally(() => {
        if (mountedRef.current) setGalleryLoading(false);
      });
  }, [lazyGalleryUrl]);

  useEffect(() => {
    if (!lazyGalleryUrl || imageCount > 0 || galleryAttemptedRef.current) return;
    if (variant === "detail") {
      loadLazyGallery();
      return;
    }
    const root = galleryRootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      loadLazyGallery();
    }, { rootMargin: "360px 0px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, [imageCount, lazyGalleryUrl, loadLazyGallery, variant]);

  const handleHeroImageError = useCallback((source: string) => {
    setFailedHeroImages((current) => {
      if (current.has(source)) return current;
      const next = new Set(current);
      next.add(source);
      return next;
    });
    loadLazyGallery();
  }, [loadLazyGallery]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeGallery();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      previousImage();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      nextImage();
      return;
    }
    if (event.key !== "Tab") return;

    const controls = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    if (controls.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const rootClassName = ["vehicle-gallery", `vehicle-gallery--${variant}`, className]
    .filter(Boolean)
    .join(" ");

  if (imageCount === 0) {
    if (lazyGalleryUrl) {
      return (
        <div ref={galleryRootRef} className={`${rootClassName} vehicle-gallery--empty`}>
          <button
            ref={triggerRef}
            className="vehicle-gallery__trigger"
            type="button"
            onClick={() => {
              setIsOpen(true);
              loadLazyGallery();
            }}
            aria-haspopup="dialog"
            aria-label={`Load ${title} official photo gallery`}
          >
            <VehicleImage
              src={null}
              alt={`${title}. Official listing gallery has not loaded yet.`}
              fallbackTitle={fallbackTitle}
              fallbackCopy={galleryLoading ? "Loading the official GSA gallery…" : fallbackCopy}
              variant={variant}
              priority={priority}
            />
            <span className="vehicle-gallery__expand" aria-hidden="true"><Maximize2 /></span>
          </button>
        </div>
      );
    }
    return (
      <div ref={galleryRootRef} className={`${rootClassName} vehicle-gallery--empty`}>
        <VehicleImage
          src={null}
          alt={`${title}. No official listing image is available.`}
          fallbackTitle={fallbackTitle}
          fallbackCopy={fallbackCopy}
          variant={variant}
          priority={priority}
        />
      </div>
    );
  }

  const dialog = (
    <div
      className="vehicle-gallery__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeGallery();
      }}
    >
      <section
        ref={dialogRef}
        className="vehicle-gallery__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="vehicle-gallery__header">
          <div>
            <h2 id={headingId}>{title}</h2>
            <p id={descriptionId}>Official GSA listing photos. Use the arrow keys to move between photos.</p>
          </div>
          <span className="vehicle-gallery__position" aria-live="polite" aria-atomic="true">
            {galleryLoading ? "Loading official gallery…" : `Photo ${displayedIndex + 1} of ${imageCount}`}
          </span>
          <button
            ref={closeButtonRef}
            className="vehicle-gallery__close"
            type="button"
            onClick={closeGallery}
            aria-label={`Close ${title} photo gallery`}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="vehicle-gallery__stage">
          {imageCount > 1 && (
            <button
              className="vehicle-gallery__previous"
              type="button"
              onClick={previousImage}
              aria-label="Show previous photo"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          )}

          <figure className="vehicle-gallery__figure">
            <VehicleImage
              src={activeImage}
              alt={`${title}, official listing photo ${displayedIndex + 1} of ${imageCount}`}
              fallbackTitle={fallbackTitle}
              fallbackCopy="This official image is no longer available. Try another photo or open the GSA listing."
              variant="detail"
              priority
              onSourceError={handleHeroImageError}
            />
            <figcaption>Official GSA listing photo {displayedIndex + 1} of {imageCount}</figcaption>
          </figure>

          {imageCount > 1 && (
            <button
              className="vehicle-gallery__next"
              type="button"
              onClick={nextImage}
              aria-label="Show next photo"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          )}
        </div>

        {imageCount > 1 && (
          <nav className="vehicle-gallery__thumbnails" aria-label={`${title} photo thumbnails`}>
            {galleryImages.map((source, index) => {
              const isFailed = failedThumbnails.has(source);
              const isCurrent = index === displayedIndex;
              return (
                <button
                  key={source}
                  className={`vehicle-gallery__thumbnail ${isCurrent ? "is-active" : ""} ${isFailed ? "is-unavailable" : ""}`}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  aria-label={`Show photo ${index + 1} of ${imageCount}`}
                  aria-current={isCurrent ? "true" : undefined}
                >
                  {isFailed ? (
                    <span><ImageIcon aria-hidden="true" /> Photo {index + 1}</span>
                  ) : (
                    // Official listing hosts are data-driven, so a native image is required here.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={source}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      onError={() => setFailedThumbnails((current) => new Set(current).add(source))}
                    />
                  )}
                </button>
              );
            })}
          </nav>
        )}
      </section>
    </div>
  );

  return (
    <div ref={galleryRootRef} className={rootClassName}>
      <button
        ref={triggerRef}
        className="vehicle-gallery__trigger"
        type="button"
        onClick={() => {
          setIsOpen(true);
          loadLazyGallery();
        }}
        aria-haspopup="dialog"
        aria-label={`Open ${title} photo gallery${imageCount > 1 ? ` with ${imageCount} photos` : ""}`}
      >
        <VehicleImage
          src={activeImage}
          alt={`${title} shown in the official GSA listing`}
          fallbackTitle={fallbackTitle}
          fallbackCopy={fallbackCopy}
          variant={variant}
          priority={priority}
          onSourceError={handleHeroImageError}
        />
        <span className="vehicle-gallery__expand" aria-hidden="true"><Maximize2 /></span>
        {imageCount > 1 && (
          <span className="vehicle-gallery__count" aria-hidden="true"><Images /> {imageCount} photos</span>
        )}
      </button>
      {dialogOpen && typeof document !== "undefined" ? createPortal(dialog, document.body) : null}
    </div>
  );
}
