var btools      = require('buffertools'),
    cbuf        = require('cbarrick-circular-buffer'),
    debug       = require('debug')('amqp10-Connection'),
    net         = require('net'),
    StateMachine= require('stately.js'),

    constants   = require('./constants');

/**
 * Connection states, from AMQP 1.0 spec:
 *
 <dl>
 <dt>START</dt>
 <dd><p>In this state a Connection exists, but nothing has been sent or received. This is the
 state an implementation would be in immediately after performing a socket connect or
 socket accept.</p></dd>

 <dt>HDR_RCVD</dt>
 <dd><p>In this state the Connection header has been received from our peer, but we have not
 yet sent anything.</p></dd>

 <dt>HDR_SENT</dt>
 <dd><p>In this state the Connection header has been sent to our peer, but we have not yet
 received anything.</p></dd>

 <dt>OPEN_PIPE</dt>
 <dd><p>In this state we have sent both the Connection header and the open frame, but we have not yet received anything.
 </p></dd>

 <dt>OC_PIPE</dt>
 <dd><p>In this state we have sent the Connection header, the open
 frame, any pipelined Connection traffic, and the close frame,
 but we have not yet received anything.</p></dd>

 <dt>OPEN_RCVD</dt>
 <dd><p>In this state we have sent and received the Connection header, and received an
 open frame from our peer, but have not yet sent an
 open frame.</p></dd>

 <dt>OPEN_SENT</dt>
 <dd><p>In this state we have sent and received the Connection header, and sent an
 open frame to our peer, but have not yet received an
 open frame.</p></dd>

 <dt>CLOSE_PIPE</dt>
 <dd><p>In this state we have send and received the Connection header, sent an
 open frame, any pipelined Connection traffic, and the
 close frame, but we have not yet received an
 open frame.</p></dd>

 <dt>OPENED</dt>
 <dd><p>In this state the Connection header and the open frame
 have both been sent and received.</p></dd>

 <dt>CLOSE_RCVD</dt>
 <dd><p>In this state we have received a close frame indicating
 that our partner has initiated a close. This means we will never have to read anything
 more from this Connection, however we can continue to write frames onto the Connection.
 If desired, an implementation could do a TCP half-close at this point to shutdown the
 read side of the Connection.</p></dd>

 <dt>CLOSE_SENT</dt>
 <dd><p>In this state we have sent a close frame to our partner.
 It is illegal to write anything more onto the Connection, however there may still be
 incoming frames. If desired, an implementation could do a TCP half-close at this point
 to shutdown the write side of the Connection.</p></dd>

 <dt>DISCARDING</dt>
 <dd><p>The DISCARDING state is a variant of the CLOSE_SENT state where the
 close is triggered by an error. In this case any incoming frames on
 the connection MUST be silently discarded until the peer's close frame
 is received.</p></dd>

 <dt>END</dt>
 <dd><p>In this state it is illegal for either endpoint to write anything more onto the
 Connection. The Connection may be safely closed and discarded.</p></dd>
 </dl>
 *
 * Connection negotiation state diagram from AMQP 1.0 spec:
 * <pre>
              R:HDR @=======@ S:HDR             R:HDR[!=S:HDR]
           +--------| START |-----+    +--------------------------------+
           |        @=======@     |    |                                |
          \|/                    \|/   |                                |
      @==========@             @==========@ S:OPEN                      |
 +----| HDR_RCVD |             | HDR_SENT |------+                      |
 |    @==========@             @==========@      |      R:HDR[!=S:HDR]  |
 |   S:HDR |                      | R:HDR        |    +-----------------+
 |         +--------+      +------+              |    |                 |
 |                 \|/    \|/                   \|/   |                 |
 |                @==========@               +-----------+ S:CLOSE      |
 |                | HDR_EXCH |               | OPEN_PIPE |----+         |
 |                @==========@               +-----------+    |         |
 |           R:OPEN |      | S:OPEN              | R:HDR      |         |
 |         +--------+      +------+      +-------+            |         |
 |        \|/                    \|/    \|/                  \|/        |
 |   @===========@             @===========@ S:CLOSE       +---------+  |
 |   | OPEN_RCVD |             | OPEN_SENT |-----+         | OC_PIPE |--+
 |   @===========@             @===========@     |         +---------+  |
 |  S:OPEN |                      | R:OPEN      \|/           | R:HDR   |
 |         |       @========@     |          +------------+   |         |
 |         +------>| OPENED |<----+          | CLOSE_PIPE |<--+         |
 |                 @========@                +------------+             |
 |           R:CLOSE |    | S:CLOSE              | R:OPEN               |
 |         +---------+    +-------+              |                      |
 |        \|/                    \|/             |                      |
 |   @============@          @=============@     |                      |
 |   | CLOSE_RCVD |          | CLOSE_SENT* |<----+                      |
 |   @============@          @=============@                            |
 | S:CLOSE |                      | R:CLOSE                             |
 |         |         @=====@      |                                     |
 |         +-------->| END |<-----+                                     |
 |                   @=====@                                            |
 |                     /|\                                              |
 |    S:HDR[!=R:HDR]    |                R:HDR[!=S:HDR]                 |
 +----------------------+-----------------------------------------------+

 R:<CTRL> = Received <CTRL>
 S:<CTRL> = Sent <CTRL>
 * Also could be DISCARDING if an error condition
 triggered the CLOSE

 </pre>
 * @constructor
 */
var Connection = function () {
    this.addressRegex = new RegExp('(amqps?)://([^:/]+)(?::([0-9]+))?(/.*)?');
    this.client = null;
    this.connectedTo = null;
    this.curbuf = new cbuf({ size: 1024, encoding: 'buffer' });
    this.dataHandler = null;
    var self = this;
    this.connSM = StateMachine.machine({
        'DISCONNECTED': {
            connect: function(address) {
                self._connect(address);
                return this.CONNECTING;
            }
        },
        'CONNECTING': {
            connected: function() {
                self._protocolHandshake();
                return this.VER_HANDSHAKE;
            },
            error: function(err) { self._processError(err); return this.DISCONNECTED; },
            terminated: function() { self._terminate(); return this.DISCONNECTED; }
        },
        'VER_HANDSHAKE': {
            validVersion: function() {
                self._openConnection();
                return this.START_CONN;
            },
            invalidVersion: function() {
                self._terminate();
                return this.DISCONNECTING;
            },
            error: function(err) { self._processError(err); return this.DISCONNECTED; },
            terminated: function() { self._terminate(); return this.DISCONNECTED; }
        },
        'START_CONN': {
            error: function(err) { self._processError(err); return this.DISCONNECTED; },
            terminated: function() { self._terminate(); return this.DISCONNECTED; }
        },
        'DISCONNECTING': {
            disconnected: function() {
                return this.DISCONNECTED;
            },
            error: function(err) { self._processError(err); return this.DISCONNECTED; },
            terminated: function() { self._terminate(); return this.DISCONNECTED; }
        }
    }).bind(function(event, oldState, newState) {
        debug('Transitioning from '+oldState+' to '+newState+' due to '+event);
    });
};

Connection.prototype._processError = function(err) {
    console.warn('Error from socket: '+err);
    // TODO: Cleanly close on error
    this._terminate();
};

Connection.prototype._receiveData = function(buffer) {
    debug('Rx: ' + buffer.toString('hex'));
    this.curbuf.write(buffer);
    if (this.dataHandler) {
        this.dataHandler();
    }
};

Connection.prototype._protocolHandshake = function() {
    this.dataHandler = this._ensureVersion;
    this.client.write(constants.amqp_version);
};

Connection.prototype._ensureVersion = function() {
    if (this.curbuf.length >= constants.amqp_version.length) {
        var serverVersion = this.curbuf.read(8);
        debug('Server AMQP Version: ' + serverVersion.toString('hex') + ' vs ' + constants.amqp_version.toString('hex'));
        if (btools.equals(serverVersion, constants.amqp_version)) {
            this.connSM.validVersion();
        } else {
            this.connSM.invalidVersion();
        }
    }
};

Connection.prototype._openConnection = function() {
    // TODO: Do some actual work here.
    this._terminate();
};

Connection.prototype._defaultPort = function(protocol) {
    switch (protocol) {
        case 'amqp': return '5672';
        case 'amqps': return '5671';
        default: throw new Error('Unknown Protocol '+protocol);
    }
};

Connection.prototype._parseAddress = function(address) {
    var results = this.addressRegex.exec(address);
    if (!results) throw new Error('Failed to parse ' + address);
    return {
        protocol: results[1],
        host: results[2],
        port: results[3] || this._defaultPort(results[1]),
        path: results[4] || '/'
    };
};

Connection.prototype._connect = function(address) {
    var parsedAddress = this._parseAddress(address);
    var self = this;
    self.connectedTo = address;
    self.client = net.connect({ port: parsedAddress.port, host: parsedAddress.host });
    self.client.on('connect', function() {
        self.connSM.connected();
    }).on('data', function(buf) {
        self._receiveData(buf);
    }).on('error', function(err) {
        self.connSM.error(err);
    }).on('end', function() {
        self.connSM.terminated();
    });
};

Connection.prototype._terminate = function() {
    if (this.client) {
        this.connectedTo = null;
        this.client.end();
        this.client = null;
    }
};

Connection.prototype.open = function(address) {
    this.connSM.connect(address);
};

Connection.prototype.close = function() {
    // TODO: Cleanly close connections.
    this.connSM.terminated();
};

module.exports = Connection;