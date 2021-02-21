const Dgram = require('dgram')
const Crypto = require('crypto')
const EventEmitter  = require('events')
const debug = require('debug')('raknet')
const Connection = require('./connection')
const ServerName = require('./utils/server_name')
const InetAddress = require('./utils/inet_address')
const Identifiers = require('./protocol/identifiers')
const UnconnectedPing = require('./protocol/unconnected_ping')
const UnconnectedPong = require('./protocol/unconnected_pong')
const OpenConnectionRequest1 = require('./protocol/open_connection_request_1')
const OpenConnectionReply1 = require('./protocol/open_connection_reply_1')
const OpenConnectionRequest2  = require('./protocol/open_connection_request_2')
const OpenConnectionReply2 = require('./protocol/open_connection_reply_2')

// Minecraft related protocol 
const PROTOCOL = 10

// Raknet ticks
const RAKNET_TPS = 100
const RAKNET_TICK_LENGTH = 1 / RAKNET_TPS

// Constantly reconnect with smaller MTU
const START_MTU_SIZE = 1492

// Listen to packets and then process them
class Client extends EventEmitter {
    /** @type {bigint} */
    id = Crypto.randomBytes(8).readBigInt64BE()  // Generate a signed random 64 bit GUID
    /** @type {ServerName} */
    name = new ServerName()
    /** @type {Dgram.Socket} */
    socket
    /** @type {Map<string, Connection>} */
    connection
    /** @type {boolean} */
    shutdown = false
    lastPong = BigInt(Date.now())

    constructor(hostname, port) {
        super()
        this.hostname = hostname
        this.port = port
        this.address = new InetAddress(hostname, port)
        this.state = 'waiting'
        this.mtuSize = START_MTU_SIZE
        this.id = -7472034367240126457n
    }

    /**
     * Creates a packet listener on given address and port.
     * 
     * @param {string} address 
     * @param {number} port 
     */
    async connect() {
        this.socket = Dgram.createSocket({ type: 'udp4' })

        this.socket.on('message', (buffer, rinfo) => {
            debug('[S->C]', buffer, rinfo)
            this.handle(buffer, rinfo)
        })

        await new Promise((resolve, reject) => {
            const failFn = e => reject(e)
            
            this.socket.once('error', failFn)
            this.socket.bind(null, null, () => {
                this.socket.removeListener('error', failFn)
                resolve()
            })
        })

        const MAX_CONNECTION_TRIES = 5
        for (let i = 0; i < MAX_CONNECTION_TRIES; i++) {
            debug('Connecting with mtu', this.mtuSize)
            this.sendConnectionRequest()
            await sleep(1500)
            if (this.state != 'waiting') break
            this.mtuSize -= 100
        }

        this.tick()  // tick sessions
        return this
    }

    handle(buffer, rinfo) {
        let header = buffer.readUInt8()  // Read packet header to recognize packet type

        let token = `${rinfo.address}:${rinfo.port}`
        // debug('[raknet] Hadling packet', buffer, this.connection)
        if (this.connection && buffer[0] > 0x20) {
            this.connection.receive(buffer)
        } else {
            // debug('Header', header.toString(16))
            switch(header) {
                case Identifiers.UnconnectedPing:
                    this.handleUnconnectedPing(buffer).then(buffer => {
                        this.socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address)
                    })
                    break
                case Identifiers.UnconnectedPong:
                    this.handleUnconnectedPong(buffer)
                    break
                case Identifiers.OpenConnectionReply1:
                    this.handleOpenConnectionReply1(buffer).then(buffer => {
                        this.sendBuffer(buffer)
                    })
                    break  
                case Identifiers.OpenConnectionReply2:
                    this.handleOpenConnectionReply2(buffer)
                    break
                case Identifiers.NoFreeIncomingConnections:
                    debug('[raknet] Server rejected connection - full?')
                    this.emit('error', 'Server is full')
                    break
                case Identifiers.ConnectionAttemptFailed:
                    debug('[raknet] Connection was rejected by server')
                    this.emit('error', 'Connection request rejected')
                    break
                default:
            } 
        }
    }

    // async handlers

    sendConnectionRequest() {
        debug('[raknet] sending connection req')
        const packet = new OpenConnectionRequest1()
        packet.mtuSize = this.mtuSize
        packet.protocol = PROTOCOL
        packet.write()
        this.sendBuffer(packet.buffer)
        this.emit('connecting', { mtuSize: packet.mtuSize, protocol: PROTOCOL })
    }

    handleUnconnectedPong(buffer) {
        debug('[raknet] got unconnected pong')
        const decodedPacket = new UnconnectedPong()
        decodedPacket.buffer = buffer
        decodedPacket.read()
        this.lastPong = BigInt(decodedPacket.sendTimestamp)
        this.emit('unconnectedPong', this.lastPong)
    }

    sendUnconnectedPing() {
        const packet = new UnconnectedPing()
        packet.sendTimeStamp = BigInt(Date.now())
        packet.clientGUID = this.id
        packet.write()
        this.sendBuffer(packet.buffer)
    }

    async handleOpenConnectionReply1(buffer) {
        debug('[raknet] Got OpenConnectionReply1')
        this.state = 'connecting'
        const decodedPacket = new OpenConnectionReply1()
        decodedPacket.buffer = buffer
        decodedPacket.read()

        const packet = new OpenConnectionRequest2()
        packet.mtuSize = decodedPacket.mtuSize
        packet.clientGUID = this.id
        packet.serverAddress = this.address
        // debug('MTU', decodedPacket, packet.mtuSize, packet.clientGUID, packet.serverAddress.address)
        packet.write()

        return packet.buffer
    }

    async handleOpenConnectionReply2(buffer) {
        debug('[client] Got conn reply 2')
        const decodedPacket = new OpenConnectionReply2()
        decodedPacket.buffer = buffer
        decodedPacket.read()

        this.connection = new Connection(this, decodedPacket.mtuSize, this.address)
        this.connection.sendConnectionRequest(this.id, decodedPacket.mtuSize)
    }

    tick() {
        let ticks = 0
        let int = setInterval(() => {
            ticks++
            if (!this.shutdown) {
                this.connection?.update(Date.now())
                if (ticks % 100 == 0) { // TODO: How long do we wait before sending? about 1s for now
                    // debug('PINGING')
                    this.connection ? this.connection.sendConnectedPing() : this.sendUnconnectedPing()

                    let td = BigInt(Date.now()) - this.lastPong
                    if (td > 4000) { // 4s timeout
                        debug(td, this.lastPong)
                        // this.close('timeout')
                        // this.shutdown = true
                    }
                }
            } else {
                clearInterval(int)
            }
        }, RAKNET_TICK_LENGTH * 1000)
    }

    /**
     * Closes the active connection
     * 
     * @param {string} reason 
     */
    close(reason) {
        this.connection?.close()
        this.connection = null
        this.shutdown = true
        debug('[client] closing', reason)
        this.emit('closeConnection', reason)
    }

    removeConnection(...args) {
        this.close(...args)
    }

    /**
     * Send packet buffer to the server
     * 
     * @param {Buffer} buffer 
     * @param {string} address 
     * @param {number} port 
     */
    sendBuffer(buffer, address = this.address.address, port = this.address.port) {
        this.socket.send(buffer, 0, buffer.length, port, address)
        debug('[C->S]', buffer)
    }
}

async function sleep(ms) {
    return new Promise(res => {
        setTimeout(() => {
            res()
        }, ms)
    })
}

module.exports = Client