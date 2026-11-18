import { useEffect, useRef, type VideoHTMLAttributes } from "react";

export function Video({ src, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.src = src;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);
  // Attachment previews play the user's own uploads, which carry no caption track.
  // oxlint-disable-next-line jsx-a11y/media-has-caption
  return <video {...props} ref={ref} />;
}
