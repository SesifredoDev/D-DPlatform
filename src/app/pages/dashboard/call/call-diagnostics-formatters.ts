import type { ParticipantMediaDiagnostics } from '../../../shared/models/video/video.model';

export function getConnectionQualityLabel(diagnostics?: ParticipantMediaDiagnostics): string {
  if (!diagnostics) {
    return 'Unknown';
  }

  switch (diagnostics.connectionQuality) {
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Good';
    case 'poor':
      return 'Poor';
    case 'lost':
      return 'Lost';
    default:
      return 'Unknown';
  }
}

export function getConnectionQualityClass(diagnostics?: ParticipantMediaDiagnostics): string {
  switch (diagnostics?.connectionQuality) {
    case 'excellent':
      return 'quality-excellent';
    case 'good':
      return 'quality-good';
    case 'poor':
      return 'quality-poor';
    case 'lost':
      return 'quality-lost';
    default:
      return 'quality-unknown';
  }
}

export function formatBitrateKbps(value: number | null | undefined): string {
  return value == null ? '--' : `${value} kbps`;
}

export function formatPacketLoss(value: number | null | undefined): string {
  return value == null ? '--' : `${value}%`;
}

export function formatJitter(value: number | null | undefined): string {
  return value == null ? '--' : `${value} ms`;
}

export function formatResolution(diagnostics?: ParticipantMediaDiagnostics): string {
  const width = diagnostics?.video?.width;
  const height = diagnostics?.video?.height;
  if (!width || !height) {
    return '--';
  }

  return `${width}x${height}`;
}

export function formatFrameRate(diagnostics?: ParticipantMediaDiagnostics): string {
  const frameRate = diagnostics?.video?.frameRate;
  return frameRate == null ? '--' : `${frameRate} fps`;
}
