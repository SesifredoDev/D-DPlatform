const { app, BrowserWindow, components, ipcMain, session } = require('electron');
const storage = require('electron-json-storage');
const path = require('path');

const isDev = !app.isPackaged;

app.commandLine.appendSwitch('enable-widevine');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: isDev
        ? path.join(__dirname, 'src', 'preload.js')
        : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      webSecurity: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36'
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = [
      'media',
      'mediaKeySystem',
      'protectedMediaIdentifier',
      'geolocation',
      'notifications'
    ];
    callback(allowedPermissions.includes(permission));
  });

  mainWindow.loadURL('http://localhost:4200');
}

app.whenReady().then(async () => {
  try {
    // Request Widevine component
    await components.whenReady();
    console.log('[DRM] Components status:', components.status());
  } catch (e) {
    console.error('[DRM] Failed to initialize components:', e);
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('load-map-library', async () => {
  return new Promise((resolve, reject) => {
    storage.get('vtt_library', function(error, data) {
      if (error) reject(error);
      else resolve(Array.isArray(data) ? data : []);
    });
  });
});

ipcMain.handle('save-map-library', async (event, libraryData) => {
  return new Promise((resolve, reject) => {
    storage.set('vtt_library', libraryData, function(error) {
      if (error) reject(error);
      else resolve(true);
    });
  });
});
