const { app, BrowserWindow } = require('electron');

function createWindow() {
  const mainWindow = new BrowserWindow({
    fullscreen: false,

    webPreferences: {
      nodeIntegration: false
    }
  });

  // DEV mode (Angular dev server)
  mainWindow.loadURL('http://localhost:4200');

  // PROD mode (after build)
  // mainWindow.loadFile('dist/d-d-platform/browser/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
