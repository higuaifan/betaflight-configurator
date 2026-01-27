const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    isElectron: true,

    // 串口相关 API
    serial: {
        // 获取串口列表
        listPorts: () => ipcRenderer.invoke('serial:listPorts'),

        // 选择要连接的端口（设置预选 ID）
        selectPort: (portId) => ipcRenderer.invoke('serial:selectPort', portId),

        // 刷新串口列表
        refreshPorts: () => ipcRenderer.invoke('serial:refreshPorts'),

        // 监听串口列表更新
        onPortsUpdated: (callback) => {
            ipcRenderer.on('serial-ports-updated', (_event, ports) => {
                callback(ports);
            });
        },

        // 移除监听器
        removePortsUpdatedListener: () => {
            ipcRenderer.removeAllListeners('serial-ports-updated');
        },
    },
});
