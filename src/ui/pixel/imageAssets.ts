/** Generated artwork is presentation-only; loading never changes simulation state. */
const images = new Map<string, Promise<HTMLImageElement | null>>();

export function loadArtImage(path: string): Promise<HTMLImageElement | null> {
  const cached = images.get(path);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement | null>((resolve) => {
    if (typeof Image === 'undefined') { resolve(null); return; }
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
    image.onerror = () => resolve(null);
    image.src = `${import.meta.env.BASE_URL}${path}`;
  });
  images.set(path, pending);
  return pending;
}
