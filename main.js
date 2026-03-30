const { app, BrowserWindow, components, ipcMain, session } = require('electron');
const storage = require('electron-json-storage');
const path = require('path');

const isDev = !app.isPackaged;

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
      // Enable standard plugins
      plugins: true,
      webSecurity: true,
      // Spotify requires a real browser User-Agent to allow playback
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
  });

  // Handle Permission Requests for Protected Content (EME)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'geolocation', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      return callback(true);
    }
    callback(false);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:4200');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/d-d-platform/browser/index.html'));
  }
}

// Clean up command line switches (removing manual widevine paths unless you have the DLLs)
// app.commandLine.appendSwitch('widevine-cdm-path', ...);

app.whenReady().then(async () => {
  await components.whenReady();
  console.log('components ready:', components.status());
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
