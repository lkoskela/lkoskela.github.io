const messageAreaElementId = 'messages';
const counterOutputElementId = 'counter';
const databaseName = 'counterDB';
const objectStoreName = 'counter';

let sessions = [];
let messages = [];


const log = (() => {
    let console_debug = console.debug;
    let console_error = console.error;
    let console_warn = console.warn;
    const appendMessage = (logLevel, message) => {
        messages.push(`[${logLevel.toUpperCase()}] ${message}`);
        if (messages.length > 20) {
            messages = messages.slice(messages.length - 20);
        }
        document.getElementById(messageAreaElementId).innerText = messages.join('\n');
    }
    return {
        error: (...data) => {
            console_error(...data);
            appendMessage('ERROR', data.join(' '));
        },
        warn: (...data) => {
            console_warn(...data);
            appendMessage('WARN', data.join(' '));
        },
        debug: (...data) => {
            console_debug(...data);
            appendMessage('DEBUG', data.join(' '));
        }
    }
})();
console.debug = log.debug;
console.error = log.error;
console.warn = log.warn;
console.log = log.debug;


function createNewSession(db) {
    let session = {
        db: db,
        counterValue: 0,
        incrementInterval: undefined,
        active: true
    }
    sessions.push(session);
    return session;
}

function stopSession(sessionOrDb) {
    if (sessionOrDb.db) {
        let session = sessionOrDb;
        console.warn(`Stopping session ${JSON.stringify(session)}`);
        session.active = false;
        if (session.incrementInterval !== undefined) {
            clearInterval(session.incrementInterval);
            session.incrementInterval = undefined;
        }
    } else if (sessionOrDb.transaction) {
        let session = getSession(sessionOrDb);
        if (session) {
            stopSession(session);
        } else {
            console.warn(`Couldn't find a session for ${JSON.stringify(sessionOrDb)}`);
        }
    } else {
        console.warn(`Don't know how to stop a ${JSON.stringify(sessionOrDb)}`);
    }
}

function getSession(db) {
    return sessions.find(x => x.db === db);
}

function stopUpdateInterval(db) {
    let session = getSession(db);
    if (session.incrementInterval !== undefined) {
        clearInterval(session.incrementInterval);
        session.incrementInterval = undefined;
    }
}

function restartUpdateInterval(db) {
    stopUpdateInterval(db);
    let session = getSession(db);
    session.incrementInterval = setInterval(() => incrementCounter(db), 1000);
}

window.onload = () => initializeApplication();

function initializeApplication() {
    if (navigator.standalone !== undefined) {
        console.log(`Running in standalone mode? ${navigator.standalone}`);
    }
    initializePersistentMode();
    initDB((db) => {
        if (db) {
            restartUpdateInterval(db);
        }
    });
}

function requestPersistentStorageMode() {
    if (navigator.storage.persist && navigator.storage.persisted) {
        navigator.storage.persisted().then((isPersistent) => {
            if (!isPersistent) {
                console.log(`Currently in standard mode. Requesting persistent mode...`);
                navigator.storage.persist().then(result => {
                    if (result) {
                        console.log(`Persistent mode granted`);
                    } else {
                        console.log(`Persistent mode NOT granted`);
                    }
                    initializePersistentMode();
                })
            }
        });
    }
}

function initializePersistentMode() {
    function getPersistenceButton() {
        return document.getElementById('request-persistence-button');
    }
    function showRequestPersistenceButton() {
        getPersistenceButton().onclick = requestPersistentStorageMode;
        getPersistenceButton().style.display = 'inline';
    }
    function hideRequestPersistenceButton() {
        getPersistenceButton().onclick = undefined;
        getPersistenceButton().style.display = 'none';
    }
    if (navigator.storage) {
        if (navigator.storage.persisted) {
            navigator.storage.persisted().then((isPersistent) => {
                if (isPersistent) {
                    console.log("Persistent mode: Storage will not be cleared except by explicit user action");
                    document.getElementById('current-persistence-mode').innerText = 'persistent';
                    hideRequestPersistenceButton();
                } else {
                    console.log("Standard mode: Storage may be cleared by the browser under storage pressure or by explicit user action");
                    document.getElementById('current-persistence-mode').innerText = 'standard';
                    showRequestPersistenceButton();
                }
            });
        }
    } else {
        console.warn(`This browser doesn't seem to support the Storage API at all? navigator.storage: `, navigator.storage);
    }
    updateStorageQuota();
    setInterval(updateStorageQuota, 1000);
    setTimeout(updateStorageDirectory, 100);
}

function updateStorageDirectory() {
    if (navigator.storage && navigator.storage.getDirectory) {
        navigator.storage.getDirectory().then(filehandle => {
            document.getElementById('persistence-directory').innerText = filehandle.name;
        })
    }
}

function updateStorageQuota() {
    if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(storageEstimate => {
            let usage = storageEstimate.usage;
            let quota = storageEstimate.quota;
            let available = quota > usage ? quota - usage : 0;
            document.getElementById('current-storage-quota').innerText = byteSize(quota).toString();
            document.getElementById('current-storage-usage').innerText = byteSize(usage).toString();
            document.getElementById('current-storage-available').innerText = byteSize(available).toString();
        });
    } else {
        document.getElementById('current-storage-quota').innerText = '?';
        document.getElementById('current-storage-usage').innerText = '?';
        document.getElementById('current-storage-available').innerText = '?';
    }
}

function initDB(callback) {
    console.debug('Initializing IndexedDB (https://developer.mozilla.org/en-US/docs/Web/API/indexedDB)');

    function initializeWithRetries(remainingRetries, callback) {
        const request = indexedDB.open('counterDB', 1);
        request.onerror = (event) => {
            if (remainingRetries > 0) {
                console.warn(`Retrying after an error opening an IndexedDB database named ${JSON.stringify(databaseName)}:`, event.target.error);
                initializeWithRetries(remainingRetries - 1, callback);
            } else {
                console.error(`Error opening an IndexedDB database named ${JSON.stringify(databaseName)}:`, event.target.error);
            }
        };
        request.onsuccess = (event) => {
            console.debug(`Opened an IndexedDB database named ${JSON.stringify(databaseName)}`);
            let session = createNewSession(event.target.result);
            readCounter(session.db, () => {
                callback(session.db);
            });
        };
        request.onupgradeneeded = (event) => {
            let db = event.target.result;
            console.debug(`Database upgrade needed to version ${db.version} – creating an IndexedDB object store named ${JSON.stringify(objectStoreName)}`);
            db.createObjectStore(objectStoreName, { autoIncrement: true });
            db.onerror = (error) => {
                console.error(`Error from IDBDatabase:`, error);
                console.debug('Closing the database...');
                let session = getSession(db);
                stopSession(session);
                db.close();
                if (session) {
                    session.db = undefined;
                }
                initializeApplication();
            }
        };
    }
    initializeWithRetries(3, callback);
}

function readCounter(db, callback) {
    let session = getSession(db);
    if (session) {
        if (session.db && session.db.transaction) {
            const transaction = session.db.transaction([objectStoreName], 'readonly');
            const store = transaction.objectStore(objectStoreName);
            const request = store.get(1);
            request.onerror = (error) => {
                console.error('Error reading counter value from IndexedDB:', error);
                callback(false);
            }
            request.onsuccess = () => {
                if (request.result) {
                    session.counterValue = request.result;
                    console.debug('Read counter value ' + JSON.stringify(session.counterValue) + ' from IndexedDB');
                    document.getElementById(counterOutputElementId).innerText = session.counterValue;
                    callback(true);
                } else {
                    callback(false);
                }
            };
        } else {
            console.warn(`readCounter(db) got a session with invalid database inside:`, session.db);
        }
    } else {
        console.warn(`readCounter(db) could not find a session for database:`, db);
        callback(false);
    }
}

function incrementCounter(db) {
    let session = getSession(db);
    if (!session) {
        console.debug(`Not incrementing counter because db instance has changed!`);
        return;
    }
    session.counterValue++;
    updateCounter(db, (ok) => {
        if (ok) {
            document.getElementById(objectStoreName).innerText = session.counterValue;
        }
    });
}

function updateCounter(db, callback) {
    let session = getSession(db);
    if (!session.db) {
        console.debug(`IDBDatabase is ${JSON.stringify(session.db)} - not even trying to update the counter...`);
        initializeApplication();
        return;
    }
    try {
        const transaction = session.db.transaction([objectStoreName], 'readwrite');
        const store = transaction.objectStore(objectStoreName);
        const request = store.put(session.counterValue, 1);
        request.onerror = (error) => {
            if (error.message === 'Database deleted by request of the user') {
                console.error(`Error writing counter value to IndexedDB – the database had been wiped under our feet... Restarting from scratch...`);
            } else {
                console.error('Unexpected error writing counter value to IndexedDB:', error);
            }
            callback(false);
        }
        request.onsuccess = () => {
            console.debug('Wrote counter value ' + session.counterValue + ' to IndexedDB');
            callback(true);
        }
    } catch (error) {
        stopSession(session);
        initializeApplication();
    }
}
