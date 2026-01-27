const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');

// 串口缓存
let serialPortsCache = [];
// 用户选择的端口 ID（用于 select-serial-port 回调）
let selectedPortId = null;
// 主窗口引用
let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
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

    // 只允许串口权限，其他权限拒绝
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, _details) => {
        // 只允许串口相关权限
        if (permission === 'serial') {
            return true;
        }
        // USB 权限也需要允许（用于 DFU 模式）
        if (permission === 'usb') {
            return true;
        }
        // 蓝牙权限
        if (permission === 'bluetooth') {
            return true;
        }
        // 其他权限默认拒绝
        console.log(`[Electron] Permission denied: ${permission} from ${requestingOrigin}`);
        return false;
    });

    // 只授权串口和USB设备
    session.defaultSession.setDevicePermissionHandler((details) => {
        // 只允许串口设备
        if (details.deviceType === 'serial') {
            return true;
        }
        // USB 设备也允许（用于 DFU）
        if (details.deviceType === 'usb') {
            return true;
        }
        // HID 设备也允许（某些飞控使用）
        if (details.deviceType === 'hid') {
            return true;
        }
        console.log(`[Electron] Device permission denied: ${details.deviceType}`);
        return false;
    });

    // 处理串口选择事件 - 这是关键！
    // 当渲染进程调用 navigator.serial.requestPort() 时触发
    mainWindow.webContents.session.on('select-serial-port', (event, portList, _webContents, callback) => {
        event.preventDefault();

        // 更新串口缓存
        serialPortsCache = portList.map(port => ({
            portId: port.portId,
            portName: port.portName || '',
            displayName: port.displayName || port.portName || 'Serial Port',
            vendorId: port.vendorId,
            productId: port.productId,
        }));

        // 通知渲染进程串口列表已更新
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('serial-ports-updated', serialPortsCache);
        }

        // 如果有预选的端口 ID，使用它
        if (selectedPortId) {
            const targetPort = portList.find(p => p.portId === selectedPortId);
            if (targetPort) {
                callback(targetPort.portId);
                selectedPortId = null;
                return;
            }
        }

        // 如果没有预选，返回空（不自动选择）
        // 这样前端可以控制选择流程
        callback('');
    });

    // 监听串口添加事件
    mainWindow.webContents.session.on('serial-port-added', (_event, port) => {
        console.log('[Electron] Serial port added:', port);
        // 添加到缓存
        const exists = serialPortsCache.some(p => p.portId === port.portId);
        if (!exists) {
            serialPortsCache.push({
                portId: port.portId,
                portName: port.portName || '',
                displayName: port.displayName || port.portName || 'Serial Port',
                vendorId: port.vendorId,
                productId: port.productId,
            });
            // 通知渲染进程
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('serial-ports-updated', serialPortsCache);
            }
        }
    });

    // 监听串口移除事件
    mainWindow.webContents.session.on('serial-port-removed', (_event, port) => {
        console.log('[Electron] Serial port removed:', port);
        // 从缓存中移除
        serialPortsCache = serialPortsCache.filter(p => p.portId !== port.portId);
        // 通知渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('serial-ports-updated', serialPortsCache);
        }
    });
}

// IPC 处理器：获取串口列表
ipcMain.handle('serial:listPorts', async () => {
    return serialPortsCache;
});

// IPC 处理器：设置要选择的端口
ipcMain.handle('serial:selectPort', async (_event, portId) => {
    selectedPortId = portId;
    return true;
});

// IPC 处理器：触发串口扫描（通过调用一次 requestPort 来刷新列表）
ipcMain.handle('serial:refreshPorts', async () => {
    // 返回当前缓存，实际刷新会在 select-serial-port 事件中完成
    return serialPortsCache;
});

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
