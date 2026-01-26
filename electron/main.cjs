const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// 禁用硬件加速（可选，解决某些显卡兼容问题）
// app.disableHardwareAcceleration();

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 550,
        icon: path.join(__dirname, '../src/images/bf_icon_128.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs'),
        },
        title: 'Betaflight Configurator',
    });

    // 开发模式加载 vite dev server，生产模式加载打包后的文件
    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../src/dist/index.html'));
    }

    // 处理 Serial API 权限请求
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        if (permission === 'serial') {
            return true;
        }
        return true;
    });

    session.defaultSession.setDevicePermissionHandler((details) => {
        if (details.deviceType === 'serial') {
            return true;
        }
        return true;
    });

    // 处理串口选择
    mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        if (portList && portList.length > 0) {
            callback(portList[0].portId);
        } else {
            callback('');
        }
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
