import emitStream from 'emit-stream'
import EventEmitter from 'events'
import datEncoding from 'dat-encoding'
import pify from 'pify'
import pda from 'pauls-dat-api'
import signatures from 'sodium-signatures'
var debug = require('debug')('dat')
import {debounce} from '../../../lib/functions'
import {grantPermission} from '../../ui/permissions'

// db modules
import * as archivesDb from '../../dbs/archives'
import hyperdrive from 'hyperdrive'
import hyperstaging from 'hyperdrive-staging-area'

// network modules
import swarmDefaults from 'datland-swarm-defaults'
import discoverySwarm from 'discovery-swarm'
const datDns = require('dat-dns')()

// file modules
import path from 'path'
import mkdirp from 'mkdirp'
import jetpack from 'fs-jetpack'
const getFolderSize = pify(require('get-folder-size'))

// constants
// =

import {
  DAT_MANIFEST_FILENAME,
  DAT_HASH_REGEX,
  DAT_URL_REGEX
} from '../../../lib/const'
import {InvalidURLError} from 'beaker-error-constants'

// globals
// =

var archives = {} // in-memory cache of archive objects. key -> archive
var archiveLoadPromises = {} // key -> promise
var archivesEvents = new EventEmitter()

// exported API
// =

export function setup () {
  // wire up event handlers
  archivesDb.on('update:archive-user-settings', async (key, settings) => {
    // emit event
    var details = {
      url: 'dat://' + key,
      isSaved: settings.isSaved
    }
    archivesEvents.emit(settings.isSaved ? 'added' : 'removed', {details})

    // update the staging based on these settings
    var archive = getArchive(key)
    if (archive) {
      reconfigureStaging(archive, settings)
    }
  })

  // load and configure all saved archives
  archivesDb.query(0, {isSaved: true}).then(
    archives => archives.forEach(a => loadArchive(a.key, a.userSettings)),
    err => console.error('Failed to load networked archives', err)
  )
}

export function createEventStream () {
  return emitStream(archivesEvents)
}

export async function generateCreatedBy (url) {
  // fetch some origin info
  var originTitle = null
  var origin = archivesDb.extractOrigin(url)
  try {
    var originKey = /dat:\/\/([^\/]*)/.exec(origin)[1]
    var originMeta = await archivesDb.getMeta(originKey)
    originTitle = originMeta.title || null
  } catch (e) {}

  // construct info
  if (originTitle) {
    return {url: origin, title: originTitle}
  }
  return {url: origin}
}

// read metadata for the archive, and store it in the meta db
export async function pullLatestArchiveMeta (archive) {
  try {
    var key = archive.key.toString('hex')

    // ready() just in case (we need .blocks)
    await pify(archive.ready.bind(archive))()

    // read the archive meta and size on disk
    var [manifest, _] = await Promise.all([
      pda.readManifest(archive.stagingFS).catch(err => {}),
      updateSizeTracking(archive)
    ])
    manifest = manifest || {}
    var {title, description, forkOf, createdBy} = manifest
    var mtime = Date.now() // use our local update time
    var isOwner = archive.writable
    var metaSize = archive.metaSize || 0
    var stagingSize = archive.stagingSize || 0

    // write the record
    var details = {title, description, forkOf, createdBy, mtime, metaSize, stagingSize, isOwner}
    debug('Writing meta', details)
    await archivesDb.setMeta(key, details)

    // emit the updated event
    details.url = 'dat://' + key
    archivesEvents.emit('updated', {details})
  } catch (e) {
    console.error('Error pulling meta', e)
  }
}

// archive creation
// =

export async function createNewArchive (manifest = {}, userSettings = {}) {
  // create the archive
  var archive = await loadArchive(null, userSettings)
  var key = datEncoding.toStr(archive.key)
  manifest.url = `dat://${key}/`

  // write the manifest then resolve
  await pda.writeManifest(archive.staging, manifest)
  await pda.commit(archive.stagingFS, {filter: manifestFilter})

  // write the user settings
  await archivesDb.setUserSettings(0, key, {
    localPath: userSettings.localPath,
    isSaved: true
  })

  // write the metadata
  await pullLatestArchiveMeta(archive)

  // write the perms
  if (manifest.createdBy && manifest.createdBy.url) {
    grantPermission('modifyDat:' + key, manifest.createdBy.url)
  }

  return manifest.url
}

export async function forkArchive (srcArchiveUrl, manifest={}, userSettings = {}) {
  srcArchiveUrl = fromKeyToURL(srcArchiveUrl)

  // get the old archive
  var dstArchive
  var srcArchive = getArchive(srcArchiveUrl)
  if (!srcArchive) {
    throw new Error('Invalid archive key')
  }

  // fetch old archive meta
  var srcManifest = await pda.readManifest(srcArchive.stagingFS).catch(err => {})
  srcManifest = srcManifest || {}

  // override any manifest data
  var dstManifest = {
    title: (manifest.title) ? manifest.title : srcManifest.title,
    description: (manifest.description) ? manifest.description : srcManifest.description,
    createdBy: manifest.createdBy,
    forkOf: (srcManifest.forkOf || []).concat(srcArchiveUrl)
  }

  // create the new archive
  var dstArchiveUrl = await createNewArchive(dstManifest, userSettings)
  var dstArchive = getArchive(dstArchiveUrl)

  // copy files
  await pda.exportArchiveToArchive({
    srcArchive: srcArchive.stagingFS,
    dstArchive: dstArchive.stagingFS,
    skipUndownloadedFiles: true,
    ignore: ['/dat.json']
  })

  return dstArchiveUrl
}

// archive management
// =

export async function loadArchive (key, userSettings=null) {
  // validate key
  var secretKey
  if (key) {
    if (!Buffer.isBuffer(key)) {
      // existing dat
      key = fromURLToKey(key)
      if (!DAT_HASH_REGEX.test(key)) {
        throw new InvalidURLError()
      }
      key = datEncoding.toBuf(key)
    }
  } else {
    // new dat, generate keys
    var kp = signatures.keyPair()
    key = kp.publicKey
    secretKey = kp.secretKey
  }

  // fallback to the promise, if possible
  var keyStr = datEncoding.toStr(key)
  if (keyStr in archiveLoadPromises) {
    return archiveLoadPromises[keyStr]
  }

  // run and cache the promise
  var p = loadArchiveInner(key, secretKey, userSettings)
  archiveLoadPromises[keyStr] = p
  p.catch(err => {
    console.error('Failed to load archive', err)
  })

  // when done, clear the promise
  const clear = () => delete archiveLoadPromises[keyStr]
  p.then(clear, clear)

  return p
}

// main logic, separated out so we can capture the promise
async function loadArchiveInner (key, secretKey, userSettings=null) {
  // load the user settings as needed
  if (!userSettings) {
    try {
      userSettings = await archivesDb.getUserSettings(key)
    } catch (e) {
      userSettings = {}
    }
  }

  // ensure the folders exist
  var metaPath = archivesDb.getArchiveMetaPath(key)
  mkdirp.sync(metaPath)

  // create the archive instance
  var archive = hyperdrive(metaPath, key, {sparse: true, secretKey})
  archive.replicationStreams = [] // list of all active replication streams
  archive.peerHistory = [] // samples of the peer count
  Object.defineProperty(archive, 'stagingFS', {
    get: () => archive.writable ? archive.staging : archive
  })

  // wait for ready
  await new Promise((resolve, reject) => {
    archive.ready(err => {
      if (err) reject(err)
      else resolve()
    })
  })
  await configureStaging(archive, userSettings, !!secretKey)
  await updateSizeTracking(archive)

  // join the swarm
  joinSwarm(archive)

  // await initial metadata sync if not the owner
  if (!archive.writable && !archive.metadata.length) {
    // wait to receive a first update
    await new Promise((resolve, reject) => {
      archive.metadata.update(err => {
        if (err) reject(err)
        else resolve()
      })
    })

    // download the full metadata
    await new Promise((resolve, reject) => {
      archive.metadata.download({start: 0, end: archive.metadata.length}, err => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  // wire up events
  archive.pullLatestArchiveMeta = debounce(() => pullLatestArchiveMeta(archive), 1e3)
  archive.metadata.on('peer-add', onNetworkChanged)
  archive.metadata.on('peer-remove', onNetworkChanged)
  archive.fileActStream = pda.createFileActivityStream(archive)
  archive.fileActStream.on('data', ([event]) => {
    if (event === 'changed') {
      archive.pullLatestArchiveMeta()
    }
  })

  cacheArchive(key, archive)
  return archive
}

export function cacheArchive (key, archive) {
  archives[datEncoding.toStr(key)] = archive
}

export function getArchive (key) {
  key = fromURLToKey(key)
  return archives[key]
}

export function getActiveArchives () {
  return archives
}

export async function getOrLoadArchive (key, opts) {
  var archive = getArchive(key)
  if (archive) {
    return archive
  }
  return loadArchive(key, opts)
}

export async function updateSizeTracking (archive) {
  var [metaSize, stagingSize] = await Promise.all([
    getFolderSize(archivesDb.getArchiveMetaPath(archive)).catch(err => 0),
    archive.staging ? getFolderSize(archive.staging.path).catch(err => 0) : 0
  ])
  archive.metaSize = metaSize
  archive.stagingSize = stagingSize
}

// archive fetch/query
// =

export async function queryArchives (query) {
  // run the query
  var archiveInfos = await archivesDb.query(0, query)

  // attach some live data
  archiveInfos.forEach(archiveInfo => {
    var archive = getArchive(archiveInfo.key)
    if (archive) {
      archiveInfo.peers = archive.metadata.peers.length
      archiveInfo.peerHistory = archive.peerHistory
    }
  })
  return archiveInfos
}

export async function getArchiveInfo (key) {
  // get the archive
  key = fromURLToKey(key)
  var archive = await getOrLoadArchive(key)

  // fetch archive data
  var [meta, userSettings] = await Promise.all([
    archivesDb.getMeta(key),
    archivesDb.getUserSettings(0, key)
  ])
  meta.key = key
  meta.url = `dat://${key}`
  meta.version = archive.version
  meta.userSettings = {localPath: userSettings.localPath, isSaved: userSettings.isSaved}
  meta.peers = archive.metadata.peers.length
  meta.peerHistory = archive.peerHistory
  if (userSettings.localPath) {
    meta.localPathExists = ((await jetpack.existsAsync(userSettings.localPath)) === 'dir')
  }

  return meta
}

export async function reconfigureStaging (archive, userSettings) {
  if (archive.staging && archive.staging.path === userSettings.localPath) {
    // no changes needed
    return
  }

  if (archive.staging) {
    // close staging if it exists
    archive.staging.stopAutoSync()
    archive.staging = null
  }

  // recreate staging
  await configureStaging(archive, userSettings)

  if (archive.writable) {
    // copy out the dat.json to the new location, if needed
    let [stagingSt, archiveSt] = await Promise.all([
      pda.stat(archive.staging, '/dat.json').catch(() => null),
      pda.stat(archive, '/dat.json').catch(() => null)
    ])
    if (archiveSt && (!stagingSt || stagingSt.mtime < archiveSt.mtime)) {
      archive.staging.revert({filter: manifestFilter})
    }
  }
}

// archive networking
// =

// put the archive into the network, for upload and download
export function joinSwarm (key, opts) {
  var archive = (typeof key == 'object' && key.key) ? key : getArchive(key)
  if (!archive || archive.isSwarming) return

  var connIdCounter = 0
  var keyStr = datEncoding.toStr(archive.key)
  var swarm = discoverySwarm(swarmDefaults({
    hash: false,
    utp: true,
    tcp: true,
    stream: (info) => {
      var dkeyStr = datEncoding.toStr(archive.discoveryKey)
      var chan = dkeyStr.slice(0,6) + '..' + dkeyStr.slice(-2)
      var keyStrShort = keyStr.slice(0,6) + '..' + keyStr.slice(-2)
      var connId = ++connIdCounter
      var start = Date.now()
      debug('new connection id=%s chan=%s type=%s host=%s key=%s', connId, chan, info.type, info.host, keyStrShort)

      // create the replication stream
      var stream = archive.replicate({live: true})
      archive.replicationStreams.push(stream)
      stream.once('close', () => {
        var rs = archive.replicationStreams
        var i = rs.indexOf(stream)
        if (i !== -1) rs.splice(rs.indexOf(stream), 1)
      })

      // timeout the connection after 5s if handshake does not occur
      var TO = setTimeout(() => {
        debug('handshake timeout (%dms) id=%s chan=%s type=%s host=%s key=%s', Date.now() - start, connId, chan, info.type, info.host, keyStrShort)
        stream.destroy(new Error('Timed out waiting for handshake'))
      }, 5000)
      stream.once('handshake', () => {
        debug('got handshake (%dms) id=%s chan=%s type=%s host=%s key=%s', Date.now() - start, connId, chan, info.type, info.host, keyStrShort)
        clearTimeout(TO)
      })

      // debugging
      stream.on('error', err => debug('error (%dms) id=%s chan=%s type=%s host=%s key=%s', Date.now() - start, connId, chan, info.type, info.host, keyStrShort, err))
      stream.on('close', err => debug('closing connection (%dms) id=%s chan=%s type=%s host=%s key=%s', Date.now() - start, connId, chan, info.type, info.host, keyStrShort))
      return stream
    }
  }))
  swarm.listen()
  swarm.on('error', err => debug('Swarm error for', keyStr, err))
  swarm.join(archive.discoveryKey)

  debug('Swarming archive', datEncoding.toStr(archive.key), 'discovery key', datEncoding.toStr(archive.discoveryKey))
  archive.isSwarming = true
  archive.swarm = swarm
}

// take the archive out of the network
export function leaveSwarm (key, cb) {
  var archive = (typeof key == 'object' && key.discoveryKey) ? key : getArchive(key)
  if (!archive || !archive.isSwarming) return

  var keyStr = datEncoding.toStr(archive.key)
  var swarm = archive.swarm

  debug('Unswarming archive %s disconnected %d peers', keyStr, archive.metadata.peers.length)
  archive.replicationStreams.forEach(stream => stream.destroy()) // stop all active replications
  archive.replicationStreams.length = 0
  archive.metadata.removeListener('peer-add', onNetworkChanged)
  archive.metadata.removeListener('peer-remove', onNetworkChanged)
  swarm.leave(archive.discoveryKey)
  swarm.destroy()
  delete archive.swarm
  archive.isSwarming = false
}

// internal methods
// =

function fromURLToKey (url) {
  if (Buffer.isBuffer(url)) {
    return url
  }
  if (url.startsWith('dat://')) {
    var match = DAT_URL_REGEX.exec(url)
    if (match) return match[1]
  }
  return url
}

function fromKeyToURL (key) {
  if (typeof key !== 'string') {
    key = datEncoding.toStr(key)
  }
  if (!key.startsWith('dat://')) {
    return `dat://${key}/`
  }
  return key
}

async function configureStaging (archive, userSettings, isWritableOverride) {
  // create staging if writable or saved
  var isWritable = (archive.writable || isWritableOverride)
  var isSaved = userSettings.isSaved
  if ((isWritable || isSaved) && !!userSettings.localPath) {
    if (archive.staging) {
      return // noop
    }

    // setup staging
    let stagingPath = userSettings.localPath
    archive.staging = hyperstaging(archive, stagingPath)

    // autosync if not writable
    if (!isWritable) {
      archive.staging.revert({skipIgnore: true}) // do a revert to capture already-DLed state
      archive.staging.startAutoSync()
    }
  } else {
    // close staging if it exists
    if (archive.staging) {
      archive.staging.stopAutoSync()      
    }
    archive.staging = null
  }
}

function onNetworkChanged (e) {
  var key = datEncoding.toStr(this.key)
  var archive = archives[key]

  var now = Date.now()
  var lastHistory = archive.peerHistory.slice(-1)[0]
  if (lastHistory && (now - lastHistory.ts) < 10e3) {
    // if the last datapoint was < 10s ago, just update it
    lastHistory.peers = this.peers.length
  } else {
    archive.peerHistory.push({
      ts: Date.now(),
      peers: this.peers.length
    })
  }

  // keep peerHistory from getting too long
  if (archive.peerHistory.length >= 500) {
    // downsize to 360 points, which at 10s intervals covers one hour
    archive.peerHistory = archive.peerHistory.slice(archive.peerHistory.length - 360)
  }

  // count # of peers
  var peers = 0
  for (var k in archives) {
    peers += archives[k].metadata.peers.length
  }
  archivesEvents.emit('network-changed', {
    details: {
      url: `dat://${key}`,
      peers: this.peers.length,
      totalPeers: peers
    }
  })
}

function manifestFilter (path) {
  // only allow /dat.json
  return (path !== '/dat.json') // (true => dont handle)
}