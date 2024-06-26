// main.js
// Main Electron process

const axios = require('axios')
const fs = require('fs')
const { exec } = require('child_process')
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const { send } = require('process')
const kill = require('tree-kill')
require('update-electron-app')()

// Create global window object
let win, iconPath
let binaryName = 'gateway_binary'
let titleBarStyle = 'hidden'
const binaryTempName = 'gateway_binary_temp'

// Create the browser window
const createWindow = () => {

    // Set platform-specific settings
    if (process.platform === 'darwin') {
        iconPath = path.join(__dirname, 'assets', 'icon.icns')
    } else if (process.platform === 'win32') {
        iconPath = path.join(__dirname, 'assets', 'icon.ico')
        binaryName += '.exe'
        titleBarStyle = 'hiddenInset'
    } else {
        iconPath = path.join(__dirname, 'assets', 'icon.png')
    }

    // Create the browser window
    win = new BrowserWindow({
        width: 640,
        height: 640,
        titleBarStyle,
        title: 'formfactories gateway',
        icon: iconPath,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    })

    // Load HTML
    win.loadFile('index.html')

    // Warn user if they try to quit the application
    win.on('close', async e => {
        if (!status.running) return
        e.preventDefault()

        const { response } = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Cancel', 'Quit Application'],
            title: 'quit formfactories gateway',
            message: 'Are you sure you want to quit? Your machines will stop communicating with formfactories.'
        })
        if (response) win.destroy()
    })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  initializeSettings()
  updateBinary()
})

app.on('before-quit', () => {
    // If the binary is running, stop it
    if (status.running) {
        status.restartOnClose = true
        stopBinary()
    }
})

// Check for updates every 5 minutes
setInterval(updateBinary, 5 * 60 * 1000)

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Initialize application settings and status
let settings = {}
let status = {
    started: false,
    running: false,
    updating: false,
    systemSupported: true,
    launchAfterUpdate: false,
    installingUpdate: false,
    restartOnClose: false,
}

// Initialize settings file
function initializeSettings () {
    if (!fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) {
        fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({
            apiKey: '',
            version: null,
        }))
    }

    readSettings()
    if (settings.apiKey) {
        status.launchAfterUpdate = true
        sendStatus()
    }
}

// Write a new API key to the settings file
ipcMain.on('api-key', (event, apiKey) => {
    settings.apiKey = apiKey
    writeSettings()
})

// Start gateway on launch if API key is set
ipcMain.on('start', (event, value) => {
    if (status.started) return
    if (status.updating) {
        status.launchAfterUpdate = true
        sendStatus()
        return
    }
    startBinary()
})

// Stop running the gateway
ipcMain.on('stop', (event, value) => {
    if (!status.started) return
    status.restartOnClose = false
    if (status.updating) {
        status.launchAfterUpdate = false
        sendStatus()
        return
    }
    stopBinary()
})

// Read settings file
function readSettings () {
    settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json')))
    win.webContents.send('api-key', settings.apiKey)
}

// Write settings file
function writeSettings () {
    fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings))
}

function postLog (text) {
    console.log(text)
    try {
        win.webContents.send('log', text)
    } catch (e) {}
}

// Update webpage with status of server
function sendStatus () {
    try {
        win.webContents.send('status', status)
    } catch (e) {}
}

// Install a gateway update if available
function updateBinary () {
    if (status.updating) return
    console.log('checking for updates... (' + process.arch + ', ' + process.platform + ')', status.updating)
    status.updating = true
    sendStatus()
    return checkForBinaryUpdates()
        .then(binary => {
            if (binary) {
                // postLog('gateway update is available (' + settings.version + ' -> ' + binary.version + ')')
                return installGatewayBinary(binary).then(() => true)
            } else {
                // postLog('gateway is up to date')
                return false
            }
        })
        .then(updated => {
            status.updating = false
            if (status.launchAfterUpdate || (updated && status.running)) {
                status.launchAfterUpdate = false
                if (proc) {
                    status.restartOnClose = true
                    stopBinary()
                }
                startBinary()
            } else {
                status.launchAfterUpdate = false
            }
            sendStatus()
        })
        .catch(err => {
            console.log('error updating binary', err)
            postLog('Error updating gateway: ' + err)
            status.updating = false
            sendStatus()
        })
}
  
// check for new updates
function checkForBinaryUpdates () {
    // console.log(process.arch, process.platform)
    // postLog('checking for updates... (' + process.arch + ', ' + process.platform + ')')
    return getGatewayBinaries()
        .then(res => {
            console.log('got binaries', res.data)
            status.systemSupported = true
            if (res.data.version > (settings.version || 0)) {
                // postLog('new version available')
                return res.data
            }
        })
        .catch(err => {
            console.log('no binary :(', err)
            status.systemSupported = false
        })
}

// Get a gateway binary for the current platform
function getGatewayBinaries () {
    console.log('getting gateway binaries for', process.arch, process.platform)
    return axios.post('https://us-central1-formfactories-incept3d.cloudfunctions.net/downloadGateway', {
        arch: process.arch,
        platform: process.platform
    })
}

// Install a gateway binary
function installGatewayBinary (binary) {
    status.installingUpdate = true
    sendStatus()
    return new Promise((resolve, reject) => {
        postLog('Downloading latest update (gateway v' + binary.version + ')...')
        const url = binary.url

        // Download the binary
        axios.get(url, { responseType: 'stream'})
            .then(res => {
                // Write the binary to disk
                res.data.pipe(fs.createWriteStream(path.join(app.getPath('userData'), binaryTempName)))
                    .on('finish', () => {
                        postLog('finished downloading update, installing...')
                        if (proc) status.launchAfterUpdate = true
                        stopBinary()
                            .then(() => {
                                // Add execute permissions to the binary
                                fs.chmodSync(path.join(app.getPath('userData'), binaryTempName), '755')
                                fs.renameSync(path.join(app.getPath('userData'), binaryTempName), path.join(app.getPath('userData'), binaryName))

                                settings.version = binary.version
                                writeSettings()
                                status.installingUpdate = false
                                sendStatus()

                                postLog('gateway update installed')
                                resolve()
                            })
                            .catch(err => {
                                console.log('error installing binary', err)
                                postLog('Error installing gateway: ' + err)
                                status.installingUpdate = false
                                sendStatus()
                                reject(err)
                            })
                    })
            })
            .catch(err => {
                console.log('error downloading binary', err)
                postLog('Error downloading update: ' + err)
                status.installingUpdate = false
                sendStatus()
                reject(err)
            })
    })
}


// Execute the gateway binary
let proc
function startBinary () {
    // Execute the binary if system is supported

    if (proc) return
    if (!status.systemSupported) {
        postLog('Unable to start gateway, this system is not yet supported')
        stopBinary()
        sendStatus()
        return
    }

    postLog('starting gateway...')
    proc = exec(path.join(app.getPath('userData'), binaryName).replace(/ /g, '\\ '))

    proc.stdout.on('data', data => {
        if (data.includes('gateway started')) {
            status.running = true
            status.restartOnClose = true
            sendStatus()
        }
        if (proc) postLog(data)
    })

    proc.stderr.on('data', data => {
        if (proc) postLog(data)
    })

    proc.on('close', code => {
        postLog('gateway stopped', code)
        status.running = false
        status.started = false

        // Restart the binary if it was closed unexpectedly
        if (status.restartOnClose) {
            startBinary()
            status.restartOnClose = false
        }
        sendStatus()
    })

    proc.on('error', err => {
        postLog('gateway error: ' + err)
    })

    proc.on('message', msg => {
        postLog('gateway message: ' + msg)
    })

    proc.on('spawn', () => {
        // postLog('gateway spawned')
        status.started = true
        sendStatus()
    })
}

// Quit the gateway binary
function stopBinary () {
    return new Promise((resolve, reject) => {
        if (proc) {
            kill(proc.pid, 'SIGTERM', err => {
                if (err) reject(err)
                else resolve()
            })
            proc = null
        } else resolve()
    })
}