import type { ThemeColors } from '../../../shared/models/theme/theme.service.model';

export function toCssImageValue(imageUrl: string | null): string {
  if (!imageUrl) {
    return 'none';
  }

  return `url("${imageUrl.replace(/"/g, '\\"')}")`;
}

export function cloneThemeColors(colors: ThemeColors): ThemeColors {
  return { ...colors };
}

export function isThemeSyncPayloadTooLarge(theme: ThemeColors, maxPayloadBytes: number): boolean {
  return getThemeSyncPayloadByteLength(theme) > maxPayloadBytes;
}

export function getThemeSyncPayloadByteLength(theme: ThemeColors): number {
  return new TextEncoder().encode(JSON.stringify({ type: 'theme-sync', theme })).byteLength;
}

export function isThemePayloadSizeError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).toLowerCase().includes('message too large');
}

export function getRevertedThemeBackground(
  theme: ThemeColors,
  lastValidBackgroundImage: string | null,
  lastValidBackgroundImageBlur: boolean
): ThemeColors {
  return {
    ...theme,
    backgroundImage: lastValidBackgroundImage,
    backgroundImageBlur: lastValidBackgroundImage
      ? lastValidBackgroundImageBlur
      : false
  };
}

export function getTemporaryAtmosphereTheme(theme: ThemeColors, url: string): ThemeColors {
  return {
    ...theme,
    backgroundImage: url,
    backgroundImageBlur: true
  };
}

export async function compressThemeBackgroundImage(
  source: File | string,
  activeColors: ThemeColors,
  maxPayloadBytes: number
): Promise<string> {
  const image = await loadImageForCompression(source);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Canvas is unavailable');
  }

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const maxDimensions = [1280, 960, 720, 540, 420, 320, 256];
  const qualities = [0.82, 0.72, 0.62, 0.52, 0.42, 0.34, 0.28];

  for (const maxDimension of maxDimensions) {
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    for (const quality of qualities) {
      const compressed = canvas.toDataURL('image/jpeg', quality);
      const candidate = {
        ...activeColors,
        backgroundImage: compressed
      };

      if (!isThemeSyncPayloadTooLarge(candidate, maxPayloadBytes)) {
        return compressed;
      }
    }
  }

  throw new Error('Compressed image is too large');
}

function loadImageForCompression(source: File | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = source instanceof File ? URL.createObjectURL(source) : null;

    image.onload = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      resolve(image);
    };

    image.onerror = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      reject(new Error('Image could not be loaded'));
    };

    image.src = objectUrl ?? source as string;
  });
}
