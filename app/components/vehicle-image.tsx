"use client";

import { CarFront } from "lucide-react";
import { useState } from "react";

type VehicleImageProps = {
  src?: string | null;
  alt: string;
  fallbackTitle: string;
  fallbackCopy: string;
  variant: "card" | "detail";
  priority?: boolean;
};

export function VehicleImage({
  src,
  alt,
  fallbackTitle,
  fallbackCopy,
  variant,
  priority = false,
}: VehicleImageProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const hasUsableSource = Boolean(src) && failedSource !== src;

  if (hasUsableSource && src) {
    return (
      // Official listing hosts are data-driven, so a native image is required here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedSource(src)}
      />
    );
  }

  return (
    <div className={variant === "detail" ? "detail-photo-placeholder" : "vehicle-placeholder"} role="img" aria-label={`${fallbackTitle}. ${fallbackCopy}`}>
      <CarFront size={variant === "detail" ? 72 : 44} aria-hidden="true" />
      {variant === "detail" ? <strong>{fallbackTitle}</strong> : <span>{fallbackTitle}</span>}
      {variant === "detail" ? <span>{fallbackCopy}</span> : <small>{fallbackCopy}</small>}
    </div>
  );
}
