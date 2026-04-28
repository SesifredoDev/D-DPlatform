import { TestBed } from '@angular/core/testing';

import { CallParticipantMetadata, Video } from './video';

describe('Video', () => {
  let service: Video;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Video);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('keeps phone companion tracks restricted to the owner desktop when not selected', () => {
    const calls: any[][] = [];
    const setTrackSubscriptionPermissions = (...args: any[]) => {
      calls.push(args);
    };
    const phoneIdentity = 'user-1:phone';
    const desktopIdentity = 'user-1:desktop';
    const desktopMetadata: CallParticipantMetadata = {
      userId: 'user-1',
      deviceId: 'desktop-device',
      deviceType: 'desktop',
      deviceRole: 'desktop-main',
      character: {},
      selectedVideoSource: 'desktop-local',
      selectedAudioSource: 'desktop-local',
    };

    (service as any).room = {
      remoteParticipants: new Map([
        [desktopIdentity, { identity: desktopIdentity, metadata: JSON.stringify(desktopMetadata) }],
      ]),
      localParticipant: { setTrackSubscriptionPermissions },
    };
    (service as any).currentParticipantIdentity = phoneIdentity;
    (service as any).phoneCompanionTargetIdentity = desktopIdentity;
    (service as any).currentParticipantMetadata = {
      userId: 'user-1',
      deviceId: 'phone-device',
      deviceType: 'mobile',
      deviceRole: 'phone-camera',
      character: {},
      selectedVideoSource: 'desktop-local',
      selectedAudioSource: 'desktop-local',
    } satisfies CallParticipantMetadata;

    (service as any).updatePhoneTrackPermissions();

    expect(calls).toEqual([[false, [{
      participantIdentity: desktopIdentity,
      allowAll: true,
    }]]]);
  });

  it('shares phone companion tracks with the room when the desktop selects that source', () => {
    const calls: any[][] = [];
    const setTrackSubscriptionPermissions = (...args: any[]) => {
      calls.push(args);
    };
    const phoneIdentity = 'user-1:phone';
    const desktopIdentity = 'user-1:desktop';
    const desktopMetadata: CallParticipantMetadata = {
      userId: 'user-1',
      deviceId: 'desktop-device',
      deviceType: 'desktop',
      deviceRole: 'desktop-main',
      character: {},
      selectedVideoSource: phoneIdentity,
      selectedAudioSource: 'desktop-local',
    };

    (service as any).room = {
      remoteParticipants: new Map([
        [desktopIdentity, { identity: desktopIdentity, metadata: JSON.stringify(desktopMetadata) }],
      ]),
      localParticipant: { setTrackSubscriptionPermissions },
    };
    (service as any).currentParticipantIdentity = phoneIdentity;
    (service as any).phoneCompanionTargetIdentity = desktopIdentity;
    (service as any).currentParticipantMetadata = {
      userId: 'user-1',
      deviceId: 'phone-device',
      deviceType: 'mobile',
      deviceRole: 'phone-camera',
      character: {},
      selectedVideoSource: 'desktop-local',
      selectedAudioSource: 'desktop-local',
    } satisfies CallParticipantMetadata;

    (service as any).updatePhoneTrackPermissions();

    expect(calls).toEqual([[true]]);
  });
});
