import type { ThemeColors } from '../../../shared/models/theme/theme.service.model';

export interface CallLivestreamParticipant {
  id: string;
  name: string;
  race?: string;
  icon?: string | null;
  level?: number;
  isDungeonMaster?: boolean;
  avatarLabel: string;
  stream: MediaStream | null;
  videoElement: HTMLVideoElement | null;
  isLocal: boolean;
  isVideoHidden: boolean;
  volumePercent: number;
  isSceneMainCharacter: boolean;
}

export interface CallLivestreamMusicState {
  title: string;
  artist: string;
  image: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  volumePercent: number;
  audioStream: MediaStream | null;
  canCaptureAudio: boolean;
  audioStreamIsPostVolume?: boolean;
  captureSource?: 'native' | 'output-capture' | 'none';
}

export interface CallLivestreamIntroState {
  videoElement: HTMLVideoElement | null;
  audioStream: MediaStream | null;
  callOpacity: number;
  introOpacity: number;
  callVolumePercent: number;
  introVolumePercent: number;
}

export interface CallLivestreamFrameState {
  theme: ThemeColors;
  temporaryAtmosphereBackground: string | null;
  participants: CallLivestreamParticipant[];
  music: CallLivestreamMusicState | null;
  intro?: CallLivestreamIntroState | null;
  isSceneMainLayoutActive: boolean;
}

export interface CallLivestreamCompositorOptions {
  width: number;
  height: number;
  frameRate: number;
}

interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImageCacheEntry {
  image: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
}

interface AudioMixNode {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}

interface StopOptions {
  preserveAudioContext?: boolean;
}

export class CallLivestreamCompositor {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private outputStream: MediaStream | null = null;
  private canvasStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;
  private silentAudioSource: AudioScheduledSourceNode | null = null;
  private silentAudioGain: GainNode | null = null;
  private animationFrame = 0;
  private lastRenderedAt = 0;
  private getState: (() => CallLivestreamFrameState) | null = null;
  private options: CallLivestreamCompositorOptions = {
    width: 1280,
    height: 720,
    frameRate: 30
  };
  private readonly imageCache = new Map<string, ImageCacheEntry>();
  private readonly audioNodes = new Map<string, AudioMixNode>();
  private readonly maxSceneMainCharacters = 4;
  private readonly sceneMainGridColumns = 12;
  private readonly sceneMainColumnsPerRow = 2;
  private readonly sceneSideColumnsPerRow = 4;

  primeAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = this.createAudioContext();
    }

    void this.audioContext.resume().catch(() => undefined);
  }

  start(
    getState: () => CallLivestreamFrameState,
    options: Partial<CallLivestreamCompositorOptions> = {}
  ): MediaStream {
    const primedAudioContext = this.audioContext?.state !== 'closed'
      ? this.audioContext
      : null;
    this.stop({ preserveAudioContext: !!primedAudioContext });
    this.getState = getState;
    this.options = {
      ...this.options,
      ...options
    };

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.options.width;
    this.canvas.height = this.options.height;
    this.canvas.style.position = 'fixed';
    this.canvas.style.left = '-10000px';
    this.canvas.style.top = '0';
    this.canvas.style.width = '1px';
    this.canvas.style.height = '1px';
    this.canvas.style.opacity = '0';
    this.canvas.style.pointerEvents = 'none';
    document.body.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d');
    if (!this.context) {
      this.stop();
      throw new Error('Canvas rendering is unavailable.');
    }

    this.canvasStream = this.canvas.captureStream(this.options.frameRate);
    this.audioContext = primedAudioContext ?? this.createAudioContext();
    this.audioDestination = this.audioContext.createMediaStreamDestination();
    this.startSilentAudioSource();
    void this.audioContext.resume().catch(() => undefined);

    this.outputStream = new MediaStream([
      ...this.canvasStream.getVideoTracks(),
      ...this.audioDestination.stream.getAudioTracks()
    ]);
    this.renderLoop(0);

    return this.outputStream;
  }

  requestFrame() {
    this.renderFrame();
    this.canvasStream?.getVideoTracks().forEach(track => {
      (track as CanvasCaptureMediaStreamTrack).requestFrame?.();
    });
  }

  stop(options: StopOptions = {}) {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }

    this.audioNodes.forEach(node => {
      node.source.disconnect();
      node.gain.disconnect();
    });
    this.audioNodes.clear();
    this.stopSilentAudioSource();

    this.canvasStream?.getTracks().forEach(track => track.stop());
    this.outputStream?.getTracks().forEach(track => track.stop());
    this.canvas?.remove();
    if (!options.preserveAudioContext) {
      void this.audioContext?.close().catch(() => undefined);
      this.audioContext = null;
    }

    this.canvas = null;
    this.context = null;
    this.outputStream = null;
    this.canvasStream = null;
    this.audioDestination = null;
    this.getState = null;
    this.lastRenderedAt = 0;
  }

  private renderLoop(timestamp: number) {
    const frameIntervalMs = 1000 / Math.max(1, this.options.frameRate);
    if (!this.lastRenderedAt || timestamp - this.lastRenderedAt >= frameIntervalMs) {
      this.renderFrame();
      this.lastRenderedAt = timestamp;
    }

    this.animationFrame = requestAnimationFrame(nextTimestamp => this.renderLoop(nextTimestamp));
  }

  private renderFrame() {
    if (!this.context || !this.canvas || !this.getState) {
      return;
    }

    const state = this.getState();
    this.syncAudioMix(state);
    this.drawScene(state);
  }

  private syncAudioMix(state: CallLivestreamFrameState) {
    if (!this.audioContext || !this.audioDestination) {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume().catch(() => undefined);
    }

    const activeKeys = new Set<string>();
    const intro = state.intro ?? null;
    const callVolumeScale = this.normalizeVolume(intro?.callVolumePercent ?? 100);
    const musicUsesOutputCapture = state.music?.captureSource === 'output-capture' &&
      !state.music.paused &&
      !!state.music.audioStream?.getAudioTracks()
        .some(track => track.readyState === 'live' && track.enabled);
    state.participants.forEach(participant => {
      if (musicUsesOutputCapture && !participant.isLocal) {
        return;
      }

      participant.stream?.getAudioTracks()
        .filter(track => track.readyState === 'live' && track.enabled)
        .forEach(track => {
          const key = `${participant.id}:${track.id}`;
          this.syncAudioTrack(key, track, participant.volumePercent * callVolumeScale, activeKeys);
        });
    });

    if (state.music?.audioStream && !state.music.paused) {
      state.music.audioStream.getAudioTracks()
        .filter(track => track.readyState === 'live' && track.enabled)
        .forEach(track => {
          this.syncAudioTrack(`music:${track.id}`, track, state.music!.volumePercent * callVolumeScale, activeKeys);
        });
    }

    if (intro?.audioStream && intro.introVolumePercent > 0) {
      intro.audioStream.getAudioTracks()
        .filter(track => track.readyState === 'live' && track.enabled)
        .forEach(track => {
          this.syncAudioTrack(`intro:${track.id}`, track, intro.introVolumePercent, activeKeys);
        });
    }

    Array.from(this.audioNodes.entries()).forEach(([key, node]) => {
      if (activeKeys.has(key)) {
        return;
      }

      node.source.disconnect();
      node.gain.disconnect();
      this.audioNodes.delete(key);
    });
  }

  private syncAudioTrack(
    key: string,
    track: MediaStreamTrack,
    volumePercent: number,
    activeKeys: Set<string>
  ) {
    activeKeys.add(key);
    const volume = this.normalizeVolume(volumePercent);
    const existingNode = this.audioNodes.get(key);
    if (existingNode) {
      existingNode.gain.gain.value = volume;
      return;
    }

    const source = this.audioContext!.createMediaStreamSource(new MediaStream([track]));
    const gain = this.audioContext!.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.audioDestination!);
    this.audioNodes.set(key, { source, gain });
  }

  private startSilentAudioSource() {
    if (!this.audioContext || !this.audioDestination) {
      return;
    }

    this.stopSilentAudioSource();
    const gain = this.audioContext.createGain();
    gain.gain.value = 0.000001;
    const source = typeof this.audioContext.createConstantSource === 'function'
      ? this.audioContext.createConstantSource()
      : this.createSilentOscillator();
    source.connect(gain);
    gain.connect(this.audioDestination);
    source.start();
    this.silentAudioSource = source;
    this.silentAudioGain = gain;
  }

  private stopSilentAudioSource() {
    try {
      this.silentAudioSource?.stop();
    } catch {
      // The source may already be stopped during stream cleanup.
    }

    try {
      this.silentAudioSource?.disconnect();
      this.silentAudioGain?.disconnect();
    } catch {
      // Audio nodes may already be detached.
    }

    this.silentAudioSource = null;
    this.silentAudioGain = null;
  }

  private createSilentOscillator(): OscillatorNode {
    const oscillator = this.audioContext!.createOscillator();
    oscillator.frequency.value = 20;
    return oscillator;
  }

  private drawScene(state: CallLivestreamFrameState) {
    const intro = state.intro ?? null;
    const callOpacity = Math.max(0, Math.min(1, intro?.callOpacity ?? 1));
    const context = this.context!;
    const canvas = this.canvas!;

    context.save();
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    if (callOpacity > 0.01) {
      context.save();
      context.globalAlpha = callOpacity;
      this.drawBackground(state);
      this.drawParticipants(state);
      this.drawMusicCard(state.music, state.theme);
      context.restore();
    }

    if (intro && intro.introOpacity > 0.01) {
      this.drawIntroVideo(intro, state.theme);
    }
  }

  private drawBackground(state: CallLivestreamFrameState) {
    const context = this.context!;
    const canvas = this.canvas!;
    const theme = state.theme;
    const backgroundColor = theme.background || '#121212';

    context.save();
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const backgroundImageUrl = state.temporaryAtmosphereBackground || theme.backgroundImage || null;
    if (backgroundImageUrl) {
      const imageEntry = this.getImageEntry(backgroundImageUrl);
      if (imageEntry.loaded && !imageEntry.failed) {
        try {
          context.globalAlpha = 0.9;
          if (state.temporaryAtmosphereBackground || theme.backgroundImageBlur) {
            context.filter = 'blur(18px)';
            this.drawImageCover(imageEntry.image, -24, -24, canvas.width + 48, canvas.height + 48);
          } else {
            this.drawImageCover(imageEntry.image, 0, 0, canvas.width, canvas.height);
          }
          context.filter = 'none';
          context.globalAlpha = 1;
          context.fillStyle = 'rgba(0, 0, 0, 0.42)';
          context.fillRect(0, 0, canvas.width, canvas.height);
        } catch {
          imageEntry.failed = true;
        }
      }
    }

    context.restore();
  }

  private drawIntroVideo(intro: CallLivestreamIntroState, theme: ThemeColors) {
    const context = this.context!;
    const canvas = this.canvas!;
    const opacity = Math.max(0, Math.min(1, intro.introOpacity));
    const video = intro.videoElement;

    context.save();
    context.globalAlpha = opacity;
    if (
      video &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      try {
        this.drawVideoCover(video, 0, 0, canvas.width, canvas.height);
        context.restore();
        return;
      } catch {
        // A remote intro video without CORS can fail canvas drawing.
      }
    }

    context.fillStyle = theme.background || '#050608';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = theme.textColor || '#eef0f6';
    context.font = `800 ${Math.max(24, Math.round(canvas.width * 0.028))}px ${theme.fontFamily || '"Segoe UI", Arial, sans-serif'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Loading intro video', canvas.width / 2, canvas.height / 2);
    context.restore();
  }

  private drawParticipants(state: CallLivestreamFrameState) {
    const participants = state.participants;
    if (!participants.length) {
      this.drawEmptyState(state.theme);
      return;
    }

    const layouts = state.isSceneMainLayoutActive && participants.some(participant => participant.isSceneMainCharacter)
      ? this.layoutSceneMain(participants)
      : this.layoutGrid(participants, this.getContentRect());

    layouts.forEach((rect, index) => {
      const participant = participants[index];
      if (participant) {
        this.drawParticipantTile(participant, rect, state.theme);
      }
    });
  }

  private drawMusicCard(music: CallLivestreamMusicState | null, theme: ThemeColors) {
    if (!music || (!music.title && !music.artist) || !this.context || !this.canvas) {
      return;
    }

    const context = this.context;
    const canvas = this.canvas;
    if (canvas.width < 360 || canvas.height < 220) {
      return;
    }

    const padding = Math.max(14, Math.round(Math.min(canvas.width, canvas.height) * 0.026));
    const cardWidth = Math.round(Math.min(380, Math.max(250, canvas.width * 0.34)));
    const cardHeight = Math.round(Math.min(86, Math.max(66, canvas.height * 0.12)));
    const x = canvas.width - padding - cardWidth;
    const y = canvas.height - padding - cardHeight;
    const radius = Math.min(18, cardHeight * 0.24);
    const primary = theme.primary || '#7289da';
    const fontFamily = theme.fontFamily || '"Segoe UI", Arial, sans-serif';
    const artworkSize = cardHeight - 18;
    const artworkX = x + 9;
    const artworkY = y + 9;
    const textX = artworkX + artworkSize + 12;
    const textWidth = Math.max(80, cardWidth - (textX - x) - 12);
    const title = music.title || 'SoundCloud';
    const artist = music.artist || (music.paused ? 'Paused' : 'Now playing');

    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.35)';
    context.shadowBlur = 14;
    context.shadowOffsetY = 4;
    this.roundRect(x, y, cardWidth, cardHeight, radius);
    context.fillStyle = this.hexToRgba(theme.background || '#121212', 0.92);
    context.fill();
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.lineWidth = 1.5;
    context.strokeStyle = this.hexToRgba(primary, 0.55);
    context.stroke();

    this.drawMusicArtwork(music, artworkX, artworkY, artworkSize, theme);

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = this.hexToRgba(primary, 0.9);
    context.font = `800 ${Math.max(10, Math.round(cardHeight * 0.15))}px ${fontFamily}`;
    this.drawTruncatedText(music.paused ? 'SoundCloud paused' : 'SoundCloud', textX, y + cardHeight * 0.28, textWidth);

    context.fillStyle = theme.textColor || '#eef0f6';
    context.font = `800 ${Math.max(14, Math.round(cardHeight * 0.22))}px ${fontFamily}`;
    this.drawTruncatedText(title, textX, y + cardHeight * 0.54, textWidth);

    context.fillStyle = 'rgba(255, 255, 255, 0.72)';
    context.font = `700 ${Math.max(11, Math.round(cardHeight * 0.16))}px ${fontFamily}`;
    this.drawTruncatedText(artist, textX, y + cardHeight * 0.76, textWidth);

    this.drawMusicProgress(music, textX, y + cardHeight - 10, textWidth, primary);
    context.restore();
  }

  private drawMusicArtwork(
    music: CallLivestreamMusicState,
    x: number,
    y: number,
    size: number,
    theme: ThemeColors
  ) {
    const context = this.context!;
    const radius = Math.min(12, size * 0.18);
    context.save();
    this.roundRect(x, y, size, size, radius);
    context.clip();

    if (music.image) {
      const artwork = this.getImageEntry(music.image);
      if (artwork.loaded && !artwork.failed) {
        try {
          this.drawImageCover(artwork.image, x, y, size, size);
          context.restore();
          return;
        } catch {
          artwork.failed = true;
        }
      }
    }

    this.drawMusicArtworkFallback(x, y, size, theme);
    context.restore();
  }

  private drawMusicArtworkFallback(x: number, y: number, size: number, theme: ThemeColors) {
    const context = this.context!;
    const primary = theme.primary || '#7289da';
    const gradient = context.createLinearGradient(x, y, x + size, y + size);
    gradient.addColorStop(0, this.hexToRgba(primary, 0.92));
    gradient.addColorStop(1, this.hexToRgba(theme.background || '#121212', 0.92));
    context.fillStyle = gradient;
    context.fillRect(x, y, size, size);
    context.fillStyle = theme.textColor || '#ffffff';
    context.font = `900 ${Math.round(size * 0.34)}px ${theme.fontFamily || '"Segoe UI", Arial, sans-serif'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('SC', x + size / 2, y + size / 2);
  }

  private drawMusicProgress(
    music: CallLivestreamMusicState,
    x: number,
    y: number,
    width: number,
    primary: string
  ) {
    if (!music.durationMs || music.durationMs <= 0 || width <= 12) {
      return;
    }

    const context = this.context!;
    const height = 4;
    const progress = Math.max(0, Math.min(1, music.positionMs / music.durationMs));
    this.roundRect(x, y, width, height, height / 2);
    context.fillStyle = 'rgba(255, 255, 255, 0.18)';
    context.fill();
    this.roundRect(x, y, Math.max(height, width * progress), height, height / 2);
    context.fillStyle = this.hexToRgba(primary, music.paused ? 0.48 : 0.86);
    context.fill();
  }

  private drawParticipantTile(
    participant: CallLivestreamParticipant,
    rect: TileRect,
    theme: ThemeColors
  ) {
    const context = this.context!;
    const radius = 24;
    context.save();
    this.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
    context.clip();

    const video = participant.videoElement;
    const canDrawVideo = !participant.isVideoHidden &&
      !!video &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;

    if (canDrawVideo && video) {
      if (participant.isLocal) {
        context.translate(rect.x + rect.width, rect.y);
        context.scale(-1, 1);
        this.drawVideoCover(video, 0, 0, rect.width, rect.height);
      } else {
        this.drawVideoCover(video, rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      this.drawAvatarPlaceholder(participant, rect, theme);
    }

    context.restore();
    this.drawTileChrome(participant, rect, theme);
  }

  private drawTileChrome(
    participant: CallLivestreamParticipant,
    rect: TileRect,
    theme: ThemeColors
  ) {
    const context = this.context!;
    context.save();
    this.roundRect(rect.x, rect.y, rect.width, rect.height, 24);
    context.lineWidth = participant.isSceneMainCharacter ? 4 : 2;
    context.strokeStyle = participant.isSceneMainCharacter
      ? this.hexToRgba(theme.primary || '#7289da', 0.85)
      : 'rgba(255, 255, 255, 0.16)';
    context.stroke();

    this.drawParticipantUnitFrame(participant, rect, theme);

    if (participant.isSceneMainCharacter) {
      this.drawSceneMainBadge(rect, theme);
    }

    context.restore();
  }

  private drawParticipantUnitFrame(
    participant: CallLivestreamParticipant,
    rect: TileRect,
    theme: ThemeColors
  ) {
    const context = this.context!;
    if (rect.width < 120 || rect.height < 72) {
      return;
    }

    const compact = rect.width < 340 || rect.height < 180;
    const inset = Math.max(8, Math.min(22, Math.round(rect.width * 0.024)));
    const portraitSize = Math.round(Math.max(32, Math.min(compact ? 44 : 54, rect.height * 0.22, rect.width * 0.16)));
    const frameHeight = portraitSize + (compact ? 10 : 14);
    const minFrameWidth = portraitSize + (compact ? 110 : 150);
    const maxFrameWidth = rect.width - inset * 2;
    const frameWidth = Math.round(Math.min(maxFrameWidth, Math.max(minFrameWidth, rect.width * (compact ? 0.76 : 0.52))));

    if (frameWidth <= portraitSize + 42 || frameHeight >= rect.height - inset) {
      return;
    }

    const x = rect.x + inset;
    const y = rect.y + rect.height - inset - frameHeight;
    const radius = Math.min(18, frameHeight / 2);
    const primary = theme.primary || '#7289da';
    const fontFamily = theme.fontFamily || '"Segoe UI", Arial, sans-serif';

    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.58)';
    context.shadowBlur = 12;
    context.shadowOffsetY = 4;
    this.roundRect(x, y, frameWidth, frameHeight, radius);
    const background = context.createLinearGradient(x, y, x + frameWidth, y);
    background.addColorStop(0, 'rgba(8, 9, 12, 0.88)');
    background.addColorStop(0.6, 'rgba(15, 17, 22, 0.72)');
    background.addColorStop(1, 'rgba(15, 17, 22, 0.28)');
    context.fillStyle = background;
    context.fill();
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    context.lineWidth = 1.5;
    context.stroke();

    const portraitInset = compact ? 5 : 7;
    const portraitX = x + portraitInset;
    const portraitY = y + (frameHeight - portraitSize) / 2;
    this.drawParticipantPortrait(participant, portraitX, portraitY, portraitSize, theme);

    const infoX = portraitX + portraitSize + (compact ? 8 : 11);
    const infoWidth = Math.max(40, x + frameWidth - infoX - 10);
    const nameSize = Math.max(13, Math.min(compact ? 17 : 21, frameHeight * 0.32));
    const raceSize = Math.max(9, Math.min(compact ? 12 : 14, frameHeight * 0.2));

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.shadowColor = 'rgba(0, 0, 0, 0.9)';
    context.shadowBlur = 4;
    context.fillStyle = theme.textColor || '#eef0f6';
    context.font = `800 ${nameSize}px ${fontFamily}`;
    this.drawTruncatedText(participant.name || 'Player', infoX, y + frameHeight * 0.43, infoWidth);

    if (participant.race) {
      context.fillStyle = 'rgba(255, 255, 255, 0.72)';
      context.font = `700 ${raceSize}px ${fontFamily}`;
      this.drawTruncatedText(participant.race, infoX, y + frameHeight * 0.66, infoWidth);
    }
    context.shadowBlur = 0;

    if (!compact && infoWidth > 70) {
      this.drawParticipantStatusBars(infoX, y + frameHeight - 13, Math.min(92, infoWidth * 0.5), primary);
    }

    const level = participant.level;
    if (typeof level === 'number' && Number.isFinite(level)) {
      this.drawLevelBadge(portraitX + portraitSize - 10, portraitY + portraitSize - 10, Math.max(16, portraitSize * 0.34), level, primary);
    }

    context.restore();
  }

  private drawParticipantPortrait(
    participant: CallLivestreamParticipant,
    x: number,
    y: number,
    size: number,
    theme: ThemeColors
  ) {
    const context = this.context!;
    const primary = theme.primary || '#7289da';

    context.save();
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    context.clip();
    context.fillStyle = '#111';
    context.fillRect(x, y, size, size);

    if (participant.isDungeonMaster) {
      this.drawDungeonMasterPortrait(x, y, size, primary);
    } else if (participant.icon) {
      const icon = this.getImageEntry(participant.icon);
      if (icon.loaded && !icon.failed) {
        try {
          this.drawImageCover(icon.image, x, y, size, size);
        } catch {
          icon.failed = true;
          this.drawPortraitFallback(participant, x, y, size, theme);
        }
      } else {
        this.drawPortraitFallback(participant, x, y, size, theme);
      }
    } else {
      this.drawPortraitFallback(participant, x, y, size, theme);
    }

    context.restore();

    context.save();
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, Math.PI * 2);
    context.lineWidth = 2;
    context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    context.stroke();
    context.restore();
  }

  private drawDungeonMasterPortrait(x: number, y: number, size: number, primary: string) {
    const context = this.context!;
    context.fillStyle = '#111';
    context.fillRect(x, y, size, size);
    context.strokeStyle = this.hexToRgba(primary, 0.85);
    context.lineWidth = Math.max(2, size * 0.06);
    const screenWidth = size * 0.5;
    const screenHeight = size * 0.34;
    const screenX = x + (size - screenWidth) / 2;
    const screenY = y + size * 0.28;
    this.roundRect(screenX, screenY, screenWidth, screenHeight, size * 0.06);
    context.stroke();
    context.beginPath();
    context.moveTo(x + size * 0.5, screenY + screenHeight);
    context.lineTo(x + size * 0.5, y + size * 0.74);
    context.moveTo(x + size * 0.35, y + size * 0.76);
    context.lineTo(x + size * 0.65, y + size * 0.76);
    context.stroke();
  }

  private drawPortraitFallback(
    participant: CallLivestreamParticipant,
    x: number,
    y: number,
    size: number,
    theme: ThemeColors
  ) {
    const context = this.context!;
    const primary = theme.primary || '#7289da';
    const gradient = context.createRadialGradient(x + size / 2, y + size / 2, size * 0.1, x + size / 2, y + size / 2, size * 0.7);
    gradient.addColorStop(0, this.hexToRgba(primary, 0.78));
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.86)');
    context.fillStyle = gradient;
    context.fillRect(x, y, size, size);
    context.fillStyle = '#fff';
    context.font = `800 ${Math.round(size * 0.42)}px ${theme.fontFamily || '"Segoe UI", Arial, sans-serif'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(participant.avatarLabel || '?', x + size / 2, y + size / 2 + size * 0.03);
    context.textAlign = 'left';
  }

  private drawParticipantStatusBars(x: number, y: number, width: number, primary: string) {
    const context = this.context!;
    const barHeight = 4;
    context.save();
    this.drawStatusBar(x, y, width, barHeight, 'rgba(0, 0, 0, 0.62)', '#ff4d4d', '#ff8080', 1);
    this.drawStatusBar(x, y + barHeight + 3, width, barHeight, 'rgba(0, 0, 0, 0.62)', primary, '#80bfff', 0.85);
    context.restore();
  }

  private drawStatusBar(
    x: number,
    y: number,
    width: number,
    height: number,
    trackColor: string,
    startColor: string,
    endColor: string,
    fillPercent: number
  ) {
    const context = this.context!;
    this.roundRect(x, y, width, height, height / 2);
    context.fillStyle = trackColor;
    context.fill();
    const fillWidth = Math.max(height, width * fillPercent);
    this.roundRect(x, y, fillWidth, height, height / 2);
    const gradient = context.createLinearGradient(x, y, x + fillWidth, y);
    gradient.addColorStop(0, startColor);
    gradient.addColorStop(1, endColor);
    context.fillStyle = gradient;
    context.fill();
  }

  private drawLevelBadge(x: number, y: number, radius: number, level: number, primary: string) {
    const context = this.context!;
    context.save();
    context.beginPath();
    context.arc(x, y, radius / 2, 0, Math.PI * 2);
    context.fillStyle = primary;
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = '#fff';
    context.font = `800 ${Math.max(9, Math.round(radius * 0.58))}px "Segoe UI", Arial, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(Math.round(level)), x, y + radius * 0.03);
    context.restore();
  }

  private drawAvatarPlaceholder(
    participant: CallLivestreamParticipant,
    rect: TileRect,
    theme: ThemeColors
  ) {
    const context = this.context!;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) * 0.18;
    const primary = theme.primary || '#7289da';

    const background = context.createRadialGradient(centerX, centerY, radius * 0.2, centerX, centerY, rect.width * 0.7);
    background.addColorStop(0, this.hexToRgba(primary, 0.36));
    background.addColorStop(1, 'rgba(0, 0, 0, 0.86)');
    context.fillStyle = background;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);

    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fillStyle = this.hexToRgba(primary, 0.72);
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    context.stroke();

    context.fillStyle = '#fff';
    context.font = `800 ${Math.round(radius * 0.92)}px ${theme.fontFamily || '"Segoe UI", Arial, sans-serif'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(participant.avatarLabel || '?', centerX, centerY + radius * 0.03);
    context.textAlign = 'left';
  }

  private drawSceneMainBadge(rect: TileRect, theme: ThemeColors) {
    const context = this.context!;
    const radius = Math.max(18, Math.min(28, rect.width * 0.035));
    const x = rect.x + rect.width - radius - 18;
    const y = rect.y + radius + 18;

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = 'rgba(0, 0, 0, 0.62)';
    context.fill();
    context.strokeStyle = this.hexToRgba(theme.primary || '#7289da', 0.75);
    context.lineWidth = 2;
    context.stroke();

    context.fillStyle = '#fbbf24';
    context.font = `800 ${Math.round(radius * 1.05)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('*', x, y + radius * 0.1);
    context.textAlign = 'left';
  }

  private drawEmptyState(theme: ThemeColors) {
    const context = this.context!;
    const canvas = this.canvas!;
    context.save();
    context.fillStyle = theme.textColor || '#eef0f6';
    context.globalAlpha = 0.72;
    context.font = `800 34px ${theme.fontFamily || '"Segoe UI", Arial, sans-serif'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Waiting for call video', canvas.width / 2, canvas.height / 2);
    context.restore();
  }

  private layoutSceneMain(participants: CallLivestreamParticipant[]): TileRect[] {
    const content = this.getContentRect();
    const mainParticipants = participants
      .filter(participant => participant.isSceneMainCharacter)
      .slice(0, this.maxSceneMainCharacters);
    if (!mainParticipants.length) {
      return this.layoutGrid(participants, content);
    }

    const mainIdSet = new Set(mainParticipants.map(participant => participant.id));
    const sideParticipants = participants.filter(participant => !mainIdSet.has(participant.id));
    const rectsById = new Map<string, TileRect>();
    const gap = 18;
    const mainRows = Math.ceil(mainParticipants.length / this.sceneMainColumnsPerRow);
    const sideRows = sideParticipants.length
      ? Math.ceil(sideParticipants.length / this.sceneSideColumnsPerRow)
      : 0;
    const columnWidth = Math.max(
      1,
      (content.width - gap * (this.sceneMainGridColumns - 1)) / this.sceneMainGridColumns
    );
    const mainAreaRatio = !sideRows
      ? 1
      : mainParticipants.length >= 3
        ? 0.8
        : 0.5;
    const desiredMainAreaHeight = Math.floor(content.height * mainAreaRatio);
    const maxMainAreaHeight = sideRows
      ? Math.max(mainRows, content.height - gap * sideRows - sideRows)
      : content.height;
    const maxAspectAwareMainAreaHeight = this.getSceneMainAspectAwareAreaHeight(
      mainParticipants.length,
      participants.length,
      mainRows,
      columnWidth,
      gap
    );
    const mainAreaHeight = Math.max(
      mainRows,
      Math.min(desiredMainAreaHeight, maxMainAreaHeight, maxAspectAwareMainAreaHeight)
    );
    const mainAreaY = content.y + (!sideRows ? (content.height - mainAreaHeight) / 2 : 0);
    const mainRowHeight = Math.max(1, (mainAreaHeight - gap * (mainRows - 1)) / mainRows);
    const sideRowHeight = sideRows
      ? Math.max(1, (content.height - mainAreaHeight - gap * sideRows) / sideRows)
      : 0;

    mainParticipants.forEach((participant, index) => {
      const rowIndex = Math.floor(index / this.sceneMainColumnsPerRow);
      const indexInRow = index % this.sceneMainColumnsPerRow;
      const rowItemCount = Math.min(
        this.sceneMainColumnsPerRow,
        mainParticipants.length - rowIndex * this.sceneMainColumnsPerRow
      );
      const columnSpan = mainParticipants.length === 1 && participants.length === 1
        ? this.sceneMainGridColumns
        : this.getSceneMainColumnSpan(rowItemCount);
      const columnIndex = this.getCenteredSceneGridColumn(indexInRow, rowItemCount, columnSpan);
      rectsById.set(participant.id, {
        x: this.getSceneGridColumnX(content, columnWidth, columnIndex, gap),
        y: mainAreaY + rowIndex * (mainRowHeight + gap),
        width: this.getSceneGridColumnWidth(columnWidth, columnSpan, gap),
        height: mainRowHeight
      });
    });

    sideParticipants.forEach((participant, index) => {
      const rowIndex = Math.floor(index / this.sceneSideColumnsPerRow);
      const indexInRow = index % this.sceneSideColumnsPerRow;
      const rowItemCount = Math.min(
        this.sceneSideColumnsPerRow,
        sideParticipants.length - rowIndex * this.sceneSideColumnsPerRow
      );
      const columnSpan = Math.floor(this.sceneMainGridColumns / this.sceneSideColumnsPerRow);
      const columnIndex = this.getCenteredSceneGridColumn(indexInRow, rowItemCount, columnSpan);
      const cellX = this.getSceneGridColumnX(content, columnWidth, columnIndex, gap);
      const cellY = content.y + mainAreaHeight + gap + rowIndex * (sideRowHeight + gap);
      const cellWidth = this.getSceneGridColumnWidth(columnWidth, columnSpan, gap);
      const tileWidth = Math.min(cellWidth, sideRowHeight * (16 / 9));
      const tileHeight = Math.min(sideRowHeight, tileWidth / (16 / 9));
      rectsById.set(participant.id, {
        x: cellX + (cellWidth - tileWidth) / 2,
        y: cellY + (sideRowHeight - tileHeight) / 2,
        width: tileWidth,
        height: tileHeight
      });
    });

    return participants.map(participant => {
      const rect = rectsById.get(participant.id);
      if (rect) {
        return rect;
      }

      return content;
    });
  }

  private getSceneMainColumnSpan(rowItemCount: number): number {
    return rowItemCount <= 1 ? 8 : 6;
  }

  private getSceneMainAspectAwareAreaHeight(
    mainParticipantCount: number,
    participantCount: number,
    rowCount: number,
    columnWidth: number,
    gap: number
  ): number {
    let rowHeight = Number.POSITIVE_INFINITY;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const rowItemCount = Math.min(
        this.sceneMainColumnsPerRow,
        mainParticipantCount - rowIndex * this.sceneMainColumnsPerRow
      );
      const columnSpan = mainParticipantCount === 1 && participantCount === 1
        ? this.sceneMainGridColumns
        : this.getSceneMainColumnSpan(rowItemCount);
      const rowWidth = this.getSceneGridColumnWidth(columnWidth, columnSpan, gap);
      rowHeight = Math.min(rowHeight, rowWidth / (16 / 9));
    }

    return Math.max(1, rowHeight) * rowCount + gap * (rowCount - 1);
  }

  private getCenteredSceneGridColumn(indexInRow: number, rowItemCount: number, columnSpan: number): number {
    const usedColumns = rowItemCount * columnSpan;
    const offsetColumns = Math.floor((this.sceneMainGridColumns - usedColumns) / 2);
    return offsetColumns + indexInRow * columnSpan;
  }

  private getSceneGridColumnX(content: TileRect, columnWidth: number, columnIndex: number, gap: number): number {
    return content.x + columnIndex * (columnWidth + gap);
  }

  private getSceneGridColumnWidth(columnWidth: number, columnSpan: number, gap: number): number {
    return columnWidth * columnSpan + gap * (columnSpan - 1);
  }

  private layoutGrid(participants: CallLivestreamParticipant[], bounds: TileRect): TileRect[] {
    const count = participants.length;
    if (!count) {
      return [];
    }

    const gap = count > 1 ? 18 : 0;
    let best: { score: number; rects: TileRect[] } | null = null;

    for (let columns = 1; columns <= count; columns += 1) {
      const rows = Math.ceil(count / columns);
      const availableWidth = bounds.width - gap * (columns - 1);
      const availableHeight = bounds.height - gap * (rows - 1);
      const tileWidthFromColumns = availableWidth / columns;
      const tileHeightFromColumns = tileWidthFromColumns / (16 / 9);
      const tileHeight = Math.min(tileHeightFromColumns, availableHeight / rows);
      const tileWidth = tileHeight * (16 / 9);
      const usedWidth = tileWidth * columns + gap * (columns - 1);
      const usedHeight = tileHeight * rows + gap * (rows - 1);
      const score = tileWidth * tileHeight - Math.abs(bounds.width / bounds.height - usedWidth / usedHeight) * 1000;
      const startX = bounds.x + (bounds.width - usedWidth) / 2;
      const startY = bounds.y + (bounds.height - usedHeight) / 2;
      const rects = participants.map((_, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        return {
          x: startX + column * (tileWidth + gap),
          y: startY + row * (tileHeight + gap),
          width: tileWidth,
          height: tileHeight
        };
      });

      if (!best || score > best.score) {
        best = { score, rects };
      }
    }

    return best?.rects ?? [];
  }

  private getContentRect(): TileRect {
    const canvas = this.canvas!;
    const padding = Math.round(Math.min(canvas.width, canvas.height) * 0.055);
    return {
      x: padding,
      y: padding,
      width: canvas.width - padding * 2,
      height: canvas.height - padding * 2
    };
  }

  private drawVideoCover(video: HTMLVideoElement, x: number, y: number, width: number, height: number) {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = x + (width - drawWidth) / 2;
    const drawY = y + (height - drawHeight) / 2;
    this.context!.drawImage(video, drawX, drawY, drawWidth, drawHeight);
  }

  private drawImageCover(image: HTMLImageElement, x: number, y: number, width: number, height: number) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) {
      return;
    }

    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = x + (width - drawWidth) / 2;
    const drawY = y + (height - drawHeight) / 2;
    this.context!.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  }

  private drawTruncatedText(text: string, x: number, y: number, maxWidth: number) {
    const context = this.context!;
    if (context.measureText(text).width <= maxWidth) {
      context.fillText(text, x, y);
      return;
    }

    const ellipsis = '...';
    let truncated = text;
    while (truncated.length > 1 && context.measureText(`${truncated}${ellipsis}`).width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }

    context.fillText(`${truncated}${ellipsis}`, x, y);
  }

  private getImageEntry(url: string): ImageCacheEntry {
    const existing = this.imageCache.get(url);
    if (existing) {
      return existing;
    }

    const image = new Image();
    image.crossOrigin = 'anonymous';
    const entry: ImageCacheEntry = {
      image,
      loaded: false,
      failed: false
    };
    image.onload = () => {
      entry.loaded = true;
    };
    image.onerror = () => {
      entry.failed = true;
    };
    image.src = url;
    this.imageCache.set(url, entry);
    return entry;
  }

  private roundRect(x: number, y: number, width: number, height: number, radius: number) {
    const context = this.context!;
    const normalizedRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + normalizedRadius, y);
    context.lineTo(x + width - normalizedRadius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + normalizedRadius);
    context.lineTo(x + width, y + height - normalizedRadius);
    context.quadraticCurveTo(x + width, y + height, x + width - normalizedRadius, y + height);
    context.lineTo(x + normalizedRadius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - normalizedRadius);
    context.lineTo(x, y + normalizedRadius);
    context.quadraticCurveTo(x, y, x + normalizedRadius, y);
    context.closePath();
  }

  private normalizeVolume(value: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }

    return Math.min(2, Math.max(0, value / 100));
  }

  private createAudioContext(): AudioContext {
    const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextConstructor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error('Audio mixing is unavailable.');
    }

    return new AudioContextConstructor();
  }

  private hexToRgba(hex: string, alpha: number): string {
    const { r, g, b } = this.hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const normalized = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '121212';
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16)
    };
  }
}
