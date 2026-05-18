import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { DeviceType, DeviceInfo } from '../../models/device/device.model';
export type { DeviceType, DeviceInfo } from '../../models/device/device.model';
const DEVICE_ID_KEY = 'device_id';
const DEVICE_TYPE_OVERRIDE_KEY = 'device_type_override';

@Injectable({
  providedIn: 'root',
})
export class DeviceService {
  private readonly deviceInfoSubject = new BehaviorSubject<DeviceInfo>(this.buildDeviceInfo());
  public readonly deviceInfo$ = this.deviceInfoSubject.asObservable();

  getDeviceId(): string {
    return this.deviceInfoSubject.value.deviceId;
  }

  getDeviceType(): DeviceType {
    return this.deviceInfoSubject.value.deviceType;
  }

  getDeviceInfo(): DeviceInfo {
    return this.deviceInfoSubject.value;
  }

  setDeviceTypeOverride(deviceType: DeviceType | null): void {
    if (deviceType) {
      localStorage.setItem(DEVICE_TYPE_OVERRIDE_KEY, deviceType);
    } else {
      localStorage.removeItem(DEVICE_TYPE_OVERRIDE_KEY);
    }

    this.refreshDeviceType();
  }

  clearDeviceTypeOverride(): void {
    this.setDeviceTypeOverride(null);
  }

  getDeviceTypeOverride(): DeviceType | null {
    const override = localStorage.getItem(DEVICE_TYPE_OVERRIDE_KEY);
    return this.isValidDeviceType(override) ? override : null;
  }

  refreshDeviceType(): DeviceType {
    const nextInfo: DeviceInfo = {
      ...this.deviceInfoSubject.value,
      deviceType: this.detectDeviceType(),
    };

    this.deviceInfoSubject.next(nextInfo);
    return nextInfo.deviceType;
  }

  private buildDeviceInfo(): DeviceInfo {
    return {
      deviceId: this.getOrCreateDeviceId(),
      deviceType: this.detectDeviceType(),
    };
  }

  private getOrCreateDeviceId(): string {
    const existingId = localStorage.getItem(DEVICE_ID_KEY);
    if (existingId) return existingId;

    const deviceId = this.generateDeviceId();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    return deviceId;
  }

  private generateDeviceId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `device-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private detectDeviceType(): DeviceType {
    const override = this.getDeviceTypeOverride();
    if (override) {
      return override;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    const touchPoints = navigator.maxTouchPoints || 0;
    const narrowScreen = window.matchMedia('(max-width: 768px)').matches;

    if (/ipad|tablet|playbook|silk/.test(userAgent)) {
      return 'tablet';
    }

    if (/android/.test(userAgent) && !/mobile/.test(userAgent)) {
      return 'tablet';
    }

    if (/mobi|iphone|ipod|android/.test(userAgent)) {
      return 'mobile';
    }

    if (touchPoints > 1 && narrowScreen) {
      return 'mobile';
    }

    if (touchPoints > 1) {
      return 'tablet';
    }

    if (window.matchMedia('(pointer: fine)').matches) {
      return 'desktop';
    }

    return 'unknown';
  }

  private isValidDeviceType(value: string | null): value is DeviceType {
    return value === 'desktop' || value === 'mobile' || value === 'tablet' || value === 'unknown';
  }
}
