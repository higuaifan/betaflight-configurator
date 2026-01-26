// Preload script
// 如果需要在渲染进程中使用 Node.js API，可以在这里暴露

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    isElectron: true,
});
