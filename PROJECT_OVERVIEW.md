# D&D Platform - Project Overview

This document provides a comprehensive technical map of the D&D Platform for LLM context injection.

## 1. Tech Stack
- **Frontend Framework**: Angular 21 (v21.0.0)
- **Desktop Wrapper**: Electron (v22.3.27)
- **Styling**: SCSS + Angular Material 21
- **Real-time Communication**: 
  - **Video/Audio/Data**: LiveKit (client & server SDK)
  - **VTT Synchronization**: Socket.io
- **Canvas/Tabletop**: Konva.js
- **API**: REST via HttpClient + WebSockets

## 2. Core Architecture
The application is a desktop-first "Virtual Tabletop" (VTT) environment. It uses Electron's main process for local persistence (DRM/Storage) and Angular for the UI.

### Key Components:
- **Electron (main.js)**: Handles Window lifecycle, DRM (Widevine) for media, and local JSON storage for map libraries.
- **VTT Engine (src/app/shared/modules/vttEngine)**: A Konva-based rendering engine for maps, tokens, and fog of war.
- **Services (src/app/shared/services)**:
  - `ServerService`: Manages Discord-like "Server" structures, channels, and roles.
  - `VideoService`: Wraps LiveKit. Handles media streams and broadcasts UI-sync commands (Spotify, Theme, VTT status).
  - `VttSync`: Orchestrates Socket.io rooms. Syncs token movements, pings, measurements, and turn orders between DM and players.

## 3. Data Flows

### Authentication & API
- **Endpoint**: `https://dissertation.pchaffey.me/api/`
- **Auth**: Token-based (JWT) via `TokenService`.
- **Interceptors**: Handles `withCredentials` and API error mapping.

### VTT Synchronization (VttSync.ts)
- **Namespaces**: Uses `/map/` path for Socket.io.
- **Roles**:
  - **Host (DM)**: Authoritative over map state, grid size, and fog of war. Broadcasts `map-update`.
  - **Player**: Joins with a specific `ICharacter`. Can only move tokens they "own" (enforced via logic in `handleRemoteAction`).
- **Events**: `token-move`, `wall-added`, `ping`, `turn-order-sync`, `map-change`.

### Media & Global Sync (Video.ts)
- **LiveKit**: Used for real-time AV.
- **Data Channel**: Custom JSON packets sent over LiveKit `DataPacket_Kind.RELIABLE`:
  - `spotify-sync`: Synchronizes music playback across all participants.
  - `theme-sync`: Syncs application-wide visual themes.
  - `vtt-session`: Signals when a VTT session starts/stops to update UI state globally.

## 4. Feature Modules
- **Auth**: Integrated login/signup.
- **Dashboard**: Server/Channel navigation.
- **Character Management**: `Manage` page for creating and editing D&D characters.
- **VTT**: Interactive canvas with layers:
  - `BackgroundLayer`: Map images.
  - `GridLayer`: Dynamic scaling.
  - `TokenLayer`: Draggable character/NPC tokens.
  - `LightLayer`: Fog of war / Line of Sight.

## 5. Development Workflow
- **Frontend Dev**: `npm run start` (ng serve)
- **Electron Dev**: `npm run electron:dev` (Concurrently runs Angular and Electron)
- **Production**: `npm run build`
