import { webSerialDevices, vendorIdNames } from "./devices";
import GUI from "../gui";
import { isElectron } from "../utils/checkCompatibility.js";

const logHead = "[WEBSERIAL]";

async function* streamAsyncIterable(reader, keepReadingFlag) {
    try {
        while (keepReadingFlag()) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                yield value;
            } catch (error) {
                console.warn(`${logHead} Read error in streamAsyncIterable:`, error);
                break;
            }
        }
    } finally {
        // Only release the lock if we still have the reader and it hasn't been released
        try {
            // Always attempt once; spec allows releasing even if the stream
            // is already closed.  `locked` is the boolean we can trust.
            if (reader?.locked) {
                reader.releaseLock();
            }
        } catch (error) {
            console.warn(`${logHead} Error releasing reader lock:`, error);
        }
    }
}

/**
 * WebSerial protocol implementation for the Serial base class
 */
class WebSerial extends EventTarget {
    constructor() {
        super();

        this.connected = false;
        this.openRequested = false;
        this.openCanceled = false;
        this.closeRequested = false;
        this.transmitting = false;
        this.connectionInfo = null;

        this.bitrate = 0;
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.failed = 0;

        this.ports = [];
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.reading = false;

        if (!navigator?.serial) {
            console.error(`${logHead} Web Serial API not supported`);
            return;
        }

        this.connect = this.connect.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.handleDisconnect = this.handleDisconnect.bind(this);
        this.handleReceiveBytes = this.handleReceiveBytes.bind(this);

        // Initialize device connection/disconnection listeners
        navigator.serial.addEventListener("connect", (e) => this.handleNewDevice(e.target));
        navigator.serial.addEventListener("disconnect", (e) => this.handleRemovedDevice(e.target));

        this.isNeedBatchWrite = false;

        // Electron 环境下设置串口列表更新监听
        if (isElectron()) {
            console.log(`${logHead} Running in Electron mode`);
            window.electronAPI.serial.onPortsUpdated((ports) => {
                console.log(`${logHead} Electron ports updated:`, ports);
                const oldPorts = this.ports;
                const newPorts = ports.map((port) => this.createElectronPort(port));
                this.electronPorts = ports;

                // 计算新增和移除的端口，分别触发事件
                const oldIds = new Set(oldPorts.map((p) => p.path));
                const newIds = new Set(newPorts.map((p) => p.path));

                // 触发移除事件
                oldPorts.forEach((port) => {
                    if (!newIds.has(port.path)) {
                        this.dispatchEvent(new CustomEvent("removedDevice", { detail: port }));
                    }
                });

                // 更新端口列表
                this.ports = newPorts;

                // 触发添加事件
                newPorts.forEach((port) => {
                    if (!oldIds.has(port.path)) {
                        this.dispatchEvent(new CustomEvent("addedDevice", { detail: port }));
                    }
                });
            });
            this.electronPorts = [];

            // 启动时尝试自动扫描（能成功就成功，失败也无所谓，下拉框焦点会再次触发）
            this.triggerElectronPortScan();
        }

        this.loadDevices();
    }

    /**
     * Electron 专用：触发串口扫描
     * 通过调用 requestPort() 触发 select-serial-port 事件，让 main 进程获取端口列表
     * 注意：这是利用副作用的方式，requestPort() 本身会失败（因为我们不预选端口），但事件会触发
     */
    async triggerElectronPortScan() {
        if (!isElectron()) {
            return;
        }
        try {
            console.log(`${logHead} Electron: triggering port scan`);
            await navigator.serial.requestPort({});
        } catch {
            // 预期会失败（因为没有预选端口），但 select-serial-port 事件已经触发
            // main 进程会在事件中获取端口列表并通过 IPC 通知我们
            console.log(`${logHead} Electron: port scan triggered (rejection is expected)`);
        }
    }

    handleNewDevice(device) {
        const added = this.createPort(device);
        this.ports.push(added);
        this.dispatchEvent(new CustomEvent("addedDevice", { detail: added }));
        return added;
    }

    handleRemovedDevice(device) {
        const removed = this.ports.find((port) => port.port === device);
        this.ports = this.ports.filter((port) => port.port !== device);
        this.dispatchEvent(new CustomEvent("removedDevice", { detail: removed }));
    }

    handleReceiveBytes(info) {
        this.bytesReceived += info.detail.byteLength;
    }

    handleDisconnect() {
        console.log(`${logHead} Device disconnected externally`);
        this.disconnect();
    }

    getConnectedPort() {
        return this.port;
    }

    createPort(port) {
        const portInfo = port.getInfo();
        const displayName = vendorIdNames[portInfo.usbVendorId]
            ? vendorIdNames[portInfo.usbVendorId]
            : `VID:${portInfo.usbVendorId} PID:${portInfo.usbProductId}`;
        return {
            path: "serial",
            displayName: `Betaflight ${displayName}`,
            vendorId: portInfo.usbVendorId,
            productId: portInfo.usbProductId,
            port: port,
        };
    }

    async loadDevices() {
        try {
            if (isElectron()) {
                // Electron 模式下使用 IPC 获取串口列表
                const electronPorts = await window.electronAPI.serial.listPorts();
                this.electronPorts = electronPorts;
                this.ports = electronPorts.map((port) => this.createElectronPort(port));
                console.log(`${logHead} Loaded ${this.ports.length} ports via Electron IPC`);
            } else {
                const ports = await navigator.serial.getPorts();
                this.ports = ports.map((port) => this.createPort(port));
            }
        } catch (error) {
            console.error(`${logHead} Error loading devices:`, error);
        }
    }

    // 将 Electron 串口格式转换为应用内部格式
    createElectronPort(electronPort) {
        const displayName = vendorIdNames[electronPort.vendorId]
            ? vendorIdNames[electronPort.vendorId]
            : electronPort.displayName || `VID:${electronPort.vendorId} PID:${electronPort.productId}`;
        return {
            path: electronPort.portId,
            displayName: `Betaflight ${displayName}`,
            vendorId: electronPort.vendorId,
            productId: electronPort.productId,
            electronPortId: electronPort.portId,
        };
    }

    async requestPermissionDevice(showAllSerialDevices = false) {
        let newPermissionPort = null;

        try {
            if (isElectron()) {
                // Electron 模式下，触发 requestPort 来刷新串口列表
                // main 进程会捕获 select-serial-port 事件并更新缓存
                try {
                    await navigator.serial.requestPort({});
                } catch {
                    // 预期会抛出错误（因为没有预选端口），忽略
                }
                // 刷新设备列表
                await this.loadDevices();
                // Electron 模式下不自动选择设备，返回 null 让用户从下拉框选择
                console.info(`${logHead} Electron: refreshed port list, found ${this.ports.length} ports`);
                newPermissionPort = null;
            } else {
                const options = showAllSerialDevices ? {} : { filters: webSerialDevices };
                const userSelectedPort = await navigator.serial.requestPort(options);

                newPermissionPort = this.ports.find((port) => port.port === userSelectedPort);

                if (!newPermissionPort) {
                    newPermissionPort = this.handleNewDevice(userSelectedPort);
                }
                console.info(`${logHead} User selected SERIAL device from permissions:`, newPermissionPort.path);
            }
        } catch (error) {
            console.error(`${logHead} User didn't select any SERIAL device when requesting permission:`, error);
        }
        return newPermissionPort;
    }

    // Electron 专用：通过 portId 获取真实的串口对象
    async getElectronSerialPort(portId) {
        try {
            // 先告诉 main 进程我们要选择哪个端口
            await window.electronAPI.serial.selectPort(portId);
            // 然后调用 requestPort 触发 select-serial-port 事件
            // main 进程会用预选的 portId 回调
            const port = await navigator.serial.requestPort({});
            return port;
        } catch (error) {
            console.error(`${logHead} Error getting Electron serial port:`, error);
            return null;
        }
    }

    async getDevices() {
        await this.loadDevices();
        return this.ports;
    }

    async connect(path, options = { baudRate: 115200 }) {
        // Prevent double connections
        if (this.connected) {
            console.log(`${logHead} Already connected, not connecting again`);
            return true;
        }

        this.openRequested = true;
        this.closeRequested = false;

        try {
            const device = this.ports.find((device) => device.path === path);
            if (!device) {
                console.error(`${logHead} Device not found:`, path);
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return false;
            }

            // Electron 模式下需要通过 IPC 获取真实的串口对象
            if (isElectron()) {
                const electronPortId = device.electronPortId || device.path;
                console.log(`${logHead} Electron: requesting port with ID:`, electronPortId);
                this.port = await this.getElectronSerialPort(electronPortId);
                if (!this.port) {
                    console.error(`${logHead} Electron: failed to get serial port`);
                    this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                    return false;
                }
            } else {
                this.port = device.port;
            }

            await this.port.open(options);

            const connectionInfo = this.port.getInfo();
            this.connectionInfo = connectionInfo;
            this.isNeedBatchWrite = this.checkIsNeedBatchWrite();
            if (this.isNeedBatchWrite) {
                console.log(`${logHead} Enabling batch write mode for AT32 on macOS`);
            }
            this.writer = this.port.writable.getWriter();
            this.reader = this.port.readable.getReader();

            if (connectionInfo && !this.openCanceled) {
                this.connected = true;
                this.connectionId = path;
                this.bitrate = options.baudRate;
                this.bytesReceived = 0;
                this.bytesSent = 0;
                this.failed = 0;
                this.openRequested = false;

                this.port.addEventListener("disconnect", this.handleDisconnect);
                this.addEventListener("receive", this.handleReceiveBytes);

                console.log(`${logHead} Connection opened with ID: ${this.connectionId}, Baud: ${options.baudRate}`);

                this.dispatchEvent(new CustomEvent("connect", { detail: connectionInfo }));

                // Start reading from the port
                this.reading = true;
                this.readLoop();

                return true;
            } else if (connectionInfo && this.openCanceled) {
                this.connectionId = path;

                console.log(`${logHead} Connection opened with ID: ${path}, but request was canceled, disconnecting`);
                // some bluetooth dongles/dongle drivers really doesn't like to be closed instantly, adding a small delay
                setTimeout(() => {
                    this.openRequested = false;
                    this.openCanceled = false;
                    this.disconnect();
                    this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                }, 150);

                return false;
            } else {
                this.openRequested = false;
                console.log(`${logHead} Failed to open serial port`);
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return false;
            }
        } catch (error) {
            console.error(`${logHead} Error connecting:`, error);
            this.openRequested = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return false;
        }
    }

    async readLoop() {
        try {
            for await (let value of streamAsyncIterable(this.reader, () => this.reading)) {
                this.dispatchEvent(new CustomEvent("receive", { detail: value }));
            }
        } catch (error) {
            console.error(`${logHead} Error reading:`, error);
            if (this.connected) {
                this.disconnect();
            }
        }
    }

    // Update disconnect method
    async disconnect() {
        // If already disconnected, just return
        if (!this.connected) {
            return true;
        }

        // Mark as disconnected immediately to prevent race conditions
        this.connected = false;
        this.transmitting = false;

        // Signal the read loop to stop BEFORE attempting cleanup
        this.reading = false;

        // If already closing, don't do it again
        if (this.closeRequested) {
            return true;
        }

        this.closeRequested = true;

        try {
            // Remove event listeners first
            this.removeEventListener("receive", this.handleReceiveBytes);

            // Small delay to allow ongoing operations to notice connection state change
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Cancel reader first if it exists - this doesn't release the lock
            if (this.reader) {
                try {
                    await this.reader.cancel();
                } catch (e) {
                    console.warn(`${logHead} Reader cancel error (can be ignored):`, e);
                }
            }

            // Don't try to release the reader lock - streamAsyncIterable will handle it
            this.reader = null;

            // Release writer lock if it exists
            if (this.writer) {
                try {
                    this.writer.releaseLock();
                } catch (e) {
                    console.warn(`${logHead} Writer release error (can be ignored):`, e);
                }
                this.writer = null;
            }

            // Close the port
            if (this.port) {
                this.port.removeEventListener("disconnect", this.handleDisconnect);
                try {
                    await this.port.close();
                } catch (e) {
                    console.warn(`${logHead} Port already closed or error during close:`, e);
                }
                this.port = null;
            }

            console.log(
                `${logHead} Connection with ID: ${this.connectionId} closed, Sent: ${this.bytesSent} bytes, Received: ${this.bytesReceived} bytes`,
            );

            this.connectionId = false;
            this.bitrate = 0;
            this.connectionInfo = null; // Reset connectionInfo
            this.closeRequested = false;

            this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
            return true;
        } catch (error) {
            console.error(`${logHead} Error disconnecting:`, error);
            this.closeRequested = false;
            // Ensure connectionInfo is reset even on error if port was potentially open
            this.connectionInfo = null;
            this.dispatchEvent(new CustomEvent("disconnect", { detail: false }));
            return false;
        } finally {
            if (this.openCanceled) {
                this.openCanceled = false;
            }
        }
    }

    checkIsNeedBatchWrite() {
        const isMac = GUI.operating_system === "MacOS";
        return isMac && vendorIdNames[this.connectionInfo.usbVendorId] === "AT32";
    }

    async batchWrite(data) {
        // AT32 on macOS requires smaller chunks (63 bytes) to work correctly due to
        // USB buffer size limitations in the macOS implementation
        const batchWriteSize = 63;
        let remainingData = data;
        while (remainingData.byteLength > batchWriteSize) {
            const sliceData = remainingData.slice(0, batchWriteSize);
            remainingData = remainingData.slice(batchWriteSize);
            try {
                await this.writer.write(sliceData);
            } catch (error) {
                console.error(`${logHead} Error writing batch chunk:`, error);
                throw error; // Re-throw to be caught by the send method
            }
        }
        await this.writer.write(remainingData);
    }

    async send(data, callback) {
        if (!this.connected || !this.writer) {
            console.error(`${logHead} Failed to send data, serial port not open`);
            if (callback) {
                callback({ bytesSent: 0 });
            }
            return { bytesSent: 0 };
        }

        try {
            if (this.isNeedBatchWrite) {
                await this.batchWrite(data);
            } else {
                await this.writer.write(data);
            }
            this.bytesSent += data.byteLength;

            const result = { bytesSent: data.byteLength };
            if (callback) {
                callback(result);
            }
            return result;
        } catch (error) {
            console.error(`${logHead} Error sending data:`, error);
            if (callback) {
                callback({ bytesSent: 0 });
            }
            return { bytesSent: 0 };
        }
    }
}

// Export the class itself, not an instance
export default WebSerial;
