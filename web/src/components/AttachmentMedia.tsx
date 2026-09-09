import { useEffect, useState, type ReactNode } from 'react';
import { attachmentUrl } from '../lib/files';

/*
  An <img> or an <a> for an attachment that may be encrypted (#222). The
  URL is resolved through lib/files.ts: a plaintext file keeps its API URL,
  a sealed one is fetched, opened with the family key and served from a
  blob URL. Until then the image is blank and the link inert — never an
  error, the row's structure is still real.
*/
function useAttachmentUrl(id: string, mime?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    attachmentUrl(id, mime)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, mime]);
  return url;
}

export function AttachmentImage({ id, mime, alt, className }: { id: string; mime?: string; alt: string; className?: string }) {
  const url = useAttachmentUrl(id, mime);
  return <img src={url ?? undefined} alt={alt} className={className} loading="lazy" decoding="async" />;
}

export function AttachmentLink({
  id,
  mime,
  filename,
  download,
  className,
  children,
}: {
  id: string;
  mime?: string;
  filename: string;
  /** Force a download rather than opening inline. */
  download?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const url = useAttachmentUrl(id, mime);
  const isBlob = url?.startsWith('blob:') ?? false;
  // A plaintext file keeps the server's ?download= switch; a blob URL uses
  // the download attribute, which also restores the real filename
  const href = url ? (isBlob || !download ? url : `${url}?download=true`) : undefined;
  return (
    <a
      href={href}
      className={className}
      {...(isBlob && download ? { download: filename } : {})}
      {...(!download ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {children}
    </a>
  );
}
