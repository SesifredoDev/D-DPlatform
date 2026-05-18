export function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null;
}

export function getSupportedMicRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }

  const supportedMimeType = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ].find(type => MediaRecorder.isTypeSupported(type));

  return supportedMimeType || null;
}

export function getSupportedSessionRecordingMimeType(stream?: MediaStream): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }

  const hasVideo = stream ? stream.getVideoTracks().length > 0 : true;
  const supportedMimeType = (hasVideo
    ? [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm'
    ]
    : [
      'audio/webm;codecs=opus',
      'audio/webm',
      'video/webm;codecs=opus',
      'video/webm'
    ]
  ).find(type => MediaRecorder.isTypeSupported(type));

  return supportedMimeType || null;
}

export async function captureStillFrameFromStream(
  stream: MediaStream,
  preferredMimeType: string
): Promise<Blob | null> {
  const videoTrack = stream.getVideoTracks().find(track => track.readyState === 'live');
  if (!videoTrack || typeof document === 'undefined') {
    return null;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([videoTrack]);

  try {
    void video.play().catch(() => undefined);
    await waitForVideoFrame(video, 2500);
    if (
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, preferredMimeType, 0.95) ??
      await canvasToBlob(canvas, 'image/png');
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
    video.remove();
  }
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  ) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let resolved = false;
    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('playing', onReady);
      window.clearTimeout(timeout);
    };
    const onReady = () => {
      if (resolved) {
        return;
      }

      resolved = true;
      cleanup();
      resolve();
    };
    const timeout = window.setTimeout(onReady, timeoutMs);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('playing', onReady);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), mimeType, quality);
  });
}
