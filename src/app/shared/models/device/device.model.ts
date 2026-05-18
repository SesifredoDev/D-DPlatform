export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface DeviceInfo {
  deviceId: string;
  deviceType: DeviceType;
}
