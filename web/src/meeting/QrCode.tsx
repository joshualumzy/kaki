import { useEffect, useState } from 'react';
import { toString as qrCodeSvg } from 'qrcode';

/** Draw a value as a QR image, with a plain failure message when the browser cannot render it. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    qrCodeSvg(value, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then((svg) => {
        if (!cancelled) {
          setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <p className="task-error" role="alert">
        QR code for {label} could not be drawn.
      </p>
    );
  }

  if (src === null) {
    return <div className="join-qr join-qr-pending" aria-hidden="true" />;
  }

  return (
    <img
      className="join-qr"
      src={src}
      alt={`QR code for ${label}`}
      width={220}
      height={220}
    />
  );
}
